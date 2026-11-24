import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DEFAULT_SUPPORT_INBOX_ALLOWED_ORIGINS } from '../../lib/support-inbox-cors';
import { WardrobeStack } from '../../lib/wardrobe-stack';
import { supportInboxRecipientParamName } from '../../src/shared/support-inbox-names';

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
      }),
    );
    expect(env).not.toHaveProperty('RESEND_API_KEY');
    expect(JSON.stringify(template.toJSON())).not.toMatch(/re_[A-Za-z0-9]{10,}/);
  });
});
