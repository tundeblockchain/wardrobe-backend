import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DEFAULT_SUPPORT_INBOX_ALLOWED_ORIGINS } from '../../lib/support-inbox-cors';
import { WardrobeStack } from '../../lib/wardrobe-stack';
import {
  firebaseFcmSecretName,
  supportInboxAppLinkParamName,
  supportInboxRecipientParamName,
} from '../../src/shared/support-inbox-names';

jest.setTimeout(180_000);

function synthTemplate(stage = 'dev'): Template {
  const previousStrategy = process.env.RECOMMENDER_STRATEGY;
  delete process.env.RECOMMENDER_STRATEGY;
  try {
    const app = new cdk.App();
    const stack = new WardrobeStack(app, `WardrobeStack-${stage}`, { stage });
    return Template.fromStack(stack);
  } finally {
    if (previousStrategy === undefined) {
      delete process.env.RECOMMENDER_STRATEGY;
    } else {
      process.env.RECOMMENDER_STRATEGY = previousStrategy;
    }
  }
}

function routesOf(template: Template) {
  return Object.values(
    template.findResources('AWS::ApiGatewayV2::Route'),
  ) as Array<{
    Properties: { RouteKey: string; AuthorizationType?: string };
  }>;
}

function functionEnvById(
  template: Template,
  idIncludes: string,
): Record<string, unknown> | undefined {
  const functions = Object.entries(
    template.findResources('AWS::Lambda::Function'),
  ) as Array<
    [
      string,
      {
        Properties: {
          Environment?: { Variables?: Record<string, unknown> };
        };
      },
    ]
  >;
  return functions.find(([id]) => id.includes(idIncludes))?.[1].Properties
    .Environment?.Variables;
}

describe('support inbox stack wiring (WARDROBE-281)', () => {
  const template = synthTemplate('dev');

  test('creates a separate support table with threading GSIs and TTL', () => {
    const tables = Object.values(
      template.findResources('AWS::DynamoDB::Table'),
    ) as Array<{ Properties?: { TableName?: string } }>;
    const names = tables.map((table) => table.Properties?.TableName);
    expect(names).toContain('wardrobe-app-dev');
    expect(names).toContain('wardrobe-support-dev');
    expect(names.filter((name) => name === 'wardrobe-support-dev')).toHaveLength(
      1,
    );

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'wardrobe-support-dev',
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      SSESpecification: { SSEEnabled: true },
      TimeToLiveSpecification: {
        AttributeName: 'ttl',
        Enabled: true,
      },
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'StatusLastMessageIndex',
          KeySchema: [
            { AttributeName: 'status', KeyType: 'HASH' },
            { AttributeName: 'lastMessageAt', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
        Match.objectLike({
          IndexName: 'UidLastMessageIndex',
          KeySchema: [
            { AttributeName: 'uid', KeyType: 'HASH' },
            { AttributeName: 'lastMessageAt', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
      ]),
    });
  });

  test('upload-url and feedback routes exist without the Firebase authorizer and API CORS covers them', () => {
    const routes = routesOf(template);
    for (const routeKey of [
      'POST /support/upload-url',
      'POST /support/feedback',
    ]) {
      const route = routes.find(
        (candidate) => candidate.Properties.RouteKey === routeKey,
      );
      expect(route).toBeDefined();
      expect(route?.Properties.AuthorizationType ?? 'NONE').toBe('NONE');
      expect(route?.Properties).not.toHaveProperty('AuthorizerId');
    }

    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: ['*'],
        AllowMethods: Match.arrayWith(['POST', 'OPTIONS']),
        AllowHeaders: Match.arrayWith(['Authorization', 'Content-Type']),
        ExposeHeaders: ['Retry-After'],
      }),
    });
  });

  test('media bucket CORS allows POST from configured support inbox origins', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: {
        CorsRules: Match.arrayWith([
          Match.objectLike({
            AllowedMethods: ['POST'],
            AllowedOrigins: [...DEFAULT_SUPPORT_INBOX_ALLOWED_ORIGINS],
            AllowedHeaders: ['*'],
            ExposedHeaders: Match.arrayWith(['ETag', 'Location']),
            MaxAge: 3000,
          }),
        ]),
      },
    });
  });

  test('does not create the recipient SSM parameter and never bakes a Resend key', () => {
    expect(template.findResources('AWS::SSM::Parameter')).toEqual({});
    template.hasOutput('SupportInboxRecipientParamName', {
      Value: supportInboxRecipientParamName('dev'),
    });
    template.hasOutput('SupportTableName', {
      Description: Match.stringLikeRegexp('support'),
    });

    const env = functionEnvById(template, 'SupportInboxFn');
    expect(env).toEqual(
      expect.objectContaining({
        SUPPORT_TABLE_NAME: expect.anything(),
        RESEND_SECRET_ARN: expect.anything(),
        SUPPORT_FROM_EMAIL: expect.anything(),
        SUPPORT_INBOX_RECIPIENT_PARAM: '/wardrobe/dev/support/recipient',
        FIREBASE_PROJECT_ID_SECRET_ARN: expect.anything(),
        SUPPORT_FEEDBACK_IP_RATE_LIMIT: '5',
        SUPPORT_FEEDBACK_EMAIL_RATE_LIMIT: '5',
        SUPPORT_UPLOAD_IP_RATE_LIMIT: '20',
        SUPPORT_INBOX_RATE_WINDOW_SECONDS: '3600',
        SUPPORT_EMAIL_TIMEOUT_MS: '3000',
      }),
    );
    expect(env).not.toHaveProperty('RESEND_API_KEY');
    expect(JSON.stringify(template.toJSON())).not.toMatch(/re_[A-Za-z0-9]{10,}/);
  });
});

describe('support inbox admin stack wiring (WARDROBE-284)', () => {
  const template = synthTemplate('dev');

  type PolicyResource = {
    Properties: {
      PolicyDocument: {
        Statement: Array<{
          Sid?: string;
          Action?: string | string[];
          Resource?: unknown;
        }>;
      };
    };
  };

  function policiesFor(fnId: string): PolicyResource[] {
    const policies = Object.values(
      template.findResources('AWS::IAM::Policy'),
    ) as PolicyResource[];
    return policies.filter((policy) => JSON.stringify(policy).includes(fnId));
  }

  function actionsFor(fnId: string, prefix: string): string[] {
    return policiesFor(fnId).flatMap((policy) =>
      policy.Properties.PolicyDocument.Statement.flatMap((statement) => {
        const actions = statement.Action;
        const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
        return list.filter((action) => action.startsWith(prefix));
      }),
    );
  }

  function statementsFor(
    fnId: string,
    action: string,
  ): PolicyResource['Properties']['PolicyDocument']['Statement'] {
    return policiesFor(fnId).flatMap((policy) =>
      policy.Properties.PolicyDocument.Statement.filter((statement) => {
        const actions = statement.Action;
        const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
        return list.includes(action);
      }),
    );
  }

  test('admin routes exist with the Firebase authorizer and API CORS covers GET/POST + Authorization', () => {
    const routes = routesOf(template);
    for (const routeKey of [
      'GET /admin/support/conversations',
      'GET /admin/support/conversations/{conversationId}',
      'POST /admin/support/conversations/{conversationId}/replies',
      'POST /admin/support/conversations/{conversationId}/close',
      'POST /admin/support/conversations/{conversationId}/messages/{messageId}/retry-email',
    ]) {
      const route = routes.find(
        (candidate) => candidate.Properties.RouteKey === routeKey,
      );
      expect(route).toBeDefined();
      expect(route?.Properties.AuthorizationType).toBe('CUSTOM');
    }

    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: ['*'],
        AllowMethods: Match.arrayWith(['GET', 'POST', 'OPTIONS']),
        AllowHeaders: Match.arrayWith(['Authorization']),
      }),
    });
  });

  test('admin Lambda has least-privilege SupportTable, S3 GetObject on support/, and SSM params', () => {
    const dynamo = actionsFor('SupportInboxAdminFn', 'dynamodb:');
    expect(dynamo.sort()).toEqual(
      [
        'dynamodb:DeleteItem',
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:Query',
        'dynamodb:UpdateItem',
      ].sort(),
    );
    expect(dynamo).not.toContain('dynamodb:Scan');

    const tableStatements = statementsFor('SupportInboxAdminFn', 'dynamodb:Query');
    const tableResources = JSON.stringify(tableStatements);
    expect(tableResources).toContain('SupportTable');
    expect(tableResources).toContain('StatusLastMessageIndex');
    expect(tableResources).not.toContain('UidLastMessageIndex');

    const s3 = actionsFor('SupportInboxAdminFn', 's3:');
    expect(s3).toEqual(['s3:GetObject']);
    expect(s3).not.toContain('s3:PutObject');
    const getObject = statementsFor('SupportInboxAdminFn', 's3:GetObject');
    expect(JSON.stringify(getObject)).toContain('support/*');

    expect(actionsFor('SupportInboxAdminFn', 'ssm:')).toEqual(['ssm:GetParameter']);
    const ssm = JSON.stringify(statementsFor('SupportInboxAdminFn', 'ssm:GetParameter'));
    expect(ssm).toContain('parameter/wardrobe/dev/support/recipient');
    expect(ssm).toContain('parameter/wardrobe/dev/support/app-link');

    const env = functionEnvById(template, 'SupportInboxAdminFn');
    expect(env).toEqual(
      expect.objectContaining({
        SUPPORT_TABLE_NAME: expect.anything(),
        RESEND_SECRET_ARN: expect.anything(),
        SUPPORT_FROM_EMAIL: expect.anything(),
        SUPPORT_INBOX_RECIPIENT_PARAM: '/wardrobe/dev/support/recipient',
        SUPPORT_INBOX_APP_LINK_PARAM: '/wardrobe/dev/support/app-link',
        FIREBASE_PROJECT_ID_SECRET_ARN: expect.anything(),
        SUPPORT_INBOX_ALLOWED_ORIGINS: DEFAULT_SUPPORT_INBOX_ALLOWED_ORIGINS.join(
          ',',
        ),
        SUPPORT_EMAIL_TIMEOUT_MS: '3000',
        SUPPORT_PUSH_TIMEOUT_MS: '3000',
        FCM_SERVICE_ACCOUNT_SECRET_ARN: firebaseFcmSecretName('dev'),
        MEDIA_BUCKET_NAME: expect.anything(),
      }),
    );
    expect(env).not.toHaveProperty('RESEND_API_KEY');
    expect(env).not.toHaveProperty('SUPPORT_INBOX_APP_LINK');
    expect(env).not.toHaveProperty('FCM_SERVICE_ACCOUNT_JSON');

    const secretStatements = statementsFor(
      'SupportInboxAdminFn',
      'secretsmanager:GetSecretValue',
    );
    const secretBlob = JSON.stringify(secretStatements);
    expect(secretBlob).toContain('firebase-fcm-??????');
    expect(secretBlob).not.toContain('fcm-service-account');
    expect(secretBlob).toContain('secretsmanager:GetSecretValue');

    expect(template.findResources('AWS::SSM::Parameter')).toEqual({});
    template.hasOutput('SupportInboxAppLinkParamName', {
      Value: supportInboxAppLinkParamName('dev'),
    });
  });

  test('app-link SSM param is read at runtime, not baked in at synth', () => {
    const env = functionEnvById(template, 'SupportInboxAdminFn');
    expect(env?.SUPPORT_INBOX_APP_LINK_PARAM).toBe(
      '/wardrobe/dev/support/app-link',
    );
    expect(env).not.toHaveProperty('SUPPORT_INBOX_APP_LINK');

    const synthesized = JSON.stringify(template.toJSON());
    expect(synthesized).toContain('/wardrobe/dev/support/app-link');
    expect(synthesized).not.toMatch(
      /"SUPPORT_INBOX_APP_LINK"\s*:\s*"https?:\/\//,
    );
    expect(actionsFor('SupportInboxAdminFn', 'ssm:')).toEqual(['ssm:GetParameter']);
    expect(
      JSON.stringify(statementsFor('SupportInboxAdminFn', 'ssm:GetParameter')),
    ).toContain('parameter/wardrobe/dev/support/app-link');
  });
});

describe('support inbox user stack wiring (WARDROBE-286)', () => {
  const template = synthTemplate('dev');

  type PolicyResource = {
    Properties: {
      PolicyDocument: {
        Statement: Array<{
          Sid?: string;
          Action?: string | string[];
          Resource?: unknown;
        }>;
      };
    };
  };

  function policiesFor(fnId: string): PolicyResource[] {
    const policies = Object.values(
      template.findResources('AWS::IAM::Policy'),
    ) as PolicyResource[];
    return policies.filter((policy) => JSON.stringify(policy).includes(fnId));
  }

  function actionsFor(fnId: string, prefix: string): string[] {
    return policiesFor(fnId).flatMap((policy) =>
      policy.Properties.PolicyDocument.Statement.flatMap((statement) => {
        const actions = statement.Action;
        const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
        return list.filter((action) => action.startsWith(prefix));
      }),
    );
  }

  function statementsFor(
    fnId: string,
    action: string,
  ): PolicyResource['Properties']['PolicyDocument']['Statement'] {
    return policiesFor(fnId).flatMap((policy) =>
      policy.Properties.PolicyDocument.Statement.filter((statement) => {
        const actions = statement.Action;
        const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
        return list.includes(action);
      }),
    );
  }

  test('user routes exist with the Firebase authorizer', () => {
    const routes = routesOf(template);
    for (const routeKey of [
      'POST /support/devices',
      'DELETE /support/devices',
      'GET /support/my/conversations',
      'GET /support/my/conversations/{id}',
      'POST /support/my/conversations/{id}/messages',
    ]) {
      const route = routes.find(
        (candidate) => candidate.Properties.RouteKey === routeKey,
      );
      expect(route).toBeDefined();
      expect(route?.Properties.AuthorizationType).toBe('CUSTOM');
    }
    expect(
      routes.find(
        (candidate) =>
          candidate.Properties.RouteKey === 'DELETE /support/devices/{token}',
      ),
    ).toBeUndefined();

    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: ['*'],
        AllowMethods: Match.arrayWith(['GET', 'POST', 'DELETE', 'OPTIONS']),
        AllowHeaders: Match.arrayWith(['Authorization']),
      }),
    });
  });

  test('user Lambda has least-privilege SupportTable GSI, S3 GetObject, and no FCM secret', () => {
    const dynamo = actionsFor('SupportInboxUserFn', 'dynamodb:');
    expect(dynamo.sort()).toEqual(
      [
        'dynamodb:DeleteItem',
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:Query',
        'dynamodb:UpdateItem',
      ].sort(),
    );
    expect(dynamo).not.toContain('dynamodb:Scan');

    const tableResources = JSON.stringify(
      statementsFor('SupportInboxUserFn', 'dynamodb:Query'),
    );
    expect(tableResources).toContain('SupportTable');
    expect(tableResources).toContain('UidLastMessageIndex');
    expect(tableResources).not.toContain('StatusLastMessageIndex');

    const s3 = actionsFor('SupportInboxUserFn', 's3:');
    expect(s3).toEqual(['s3:GetObject']);
    expect(JSON.stringify(statementsFor('SupportInboxUserFn', 's3:GetObject'))).toContain(
      'support/*',
    );

    const env = functionEnvById(template, 'SupportInboxUserFn');
    expect(env).toEqual(
      expect.objectContaining({
        SUPPORT_TABLE_NAME: expect.anything(),
        RESEND_SECRET_ARN: expect.anything(),
        SUPPORT_FROM_EMAIL: expect.anything(),
        SUPPORT_INBOX_RECIPIENT_PARAM: '/wardrobe/dev/support/recipient',
        FIREBASE_PROJECT_ID_SECRET_ARN: expect.anything(),
        SUPPORT_EMAIL_TIMEOUT_MS: '3000',
        MEDIA_BUCKET_NAME: expect.anything(),
      }),
    );
    expect(env).not.toHaveProperty('RESEND_API_KEY');
    expect(env).not.toHaveProperty('FCM_SERVICE_ACCOUNT_SECRET_ARN');
    expect(env).not.toHaveProperty('FCM_SERVICE_ACCOUNT_JSON');
    expect(JSON.stringify(policiesFor('SupportInboxUserFn'))).not.toContain(
      'fcm-service-account',
    );
    expect(JSON.stringify(policiesFor('SupportInboxUserFn'))).not.toContain(
      'firebase-fcm',
    );

    const functions = Object.entries(
      template.findResources('AWS::Lambda::Function'),
    ) as Array<[string, { Properties?: { Nodejs?: unknown } }]>;
    for (const [id] of functions.filter(
      ([logicalId]) =>
        logicalId.includes('SupportInboxUserFn') ||
        logicalId.includes('SupportInboxAdminFn'),
    )) {
      expect(id).not.toMatch(/firebase-admin/i);
    }
  });

  test('imports firebase-fcm by name and does not create fcm-service-account', () => {
    const secrets = Object.values(
      template.findResources('AWS::SecretsManager::Secret'),
    ) as Array<{ Properties?: { Name?: string } }>;
    const names = secrets.map((secret) => secret.Properties?.Name);
    expect(names).toContain(firebaseFcmSecretName('dev'));
    expect(names).not.toContain('wardrobe/dev/fcm-service-account');
    const outputIds = Object.keys(template.toJSON().Outputs ?? {});
    expect(
      outputIds.some((id) => id.includes('SupportFcmServiceAccountSecretName')),
    ).toBe(false);

    const synthesized = JSON.stringify(template.toJSON());
    expect(synthesized).toContain('wardrobe/dev/firebase-fcm');
    expect(synthesized).toContain('firebase-fcm-??????');
    expect(synthesized).not.toContain('wardrobe/dev/fcm-service-account');
    expect(synthesized).not.toContain('SupportFcmServiceAccountSecret');
    expect(synthesized).not.toMatch(/BEGIN PRIVATE KEY/);
    expect(synthesized).not.toMatch(/firebase-adminsdk/);
    expect(synthesized).not.toMatch(/re_[A-Za-z0-9]{10,}/);
    expect(synthesized).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
    expect(synthesized).not.toContain('ya29.');
  });
});
