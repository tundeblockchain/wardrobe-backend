import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { WardrobeStack } from '../../lib/wardrobe-stack';

jest.setTimeout(180_000);

function synthTemplate(
  stage = 'dev',
  context: Record<string, string> = {},
): Template {
  const previousStrategy = process.env.RECOMMENDER_STRATEGY;
  delete process.env.RECOMMENDER_STRATEGY;
  try {
    const app = new cdk.App({ context });
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

describe('WardrobeStack foundation (WARDROBE-4)', () => {
  const template = synthTemplate('dev');

  test('DynamoDB single table uses PK/SK and stage-aware name', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'wardrobe-app-dev',
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ]),
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      SSESpecification: { SSEEnabled: true },
    });
  });

  test('S3 media bucket blocks public access, encrypts, and enforces SSL', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256',
            },
          },
        ],
      },
      OwnershipControls: {
        Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }],
      },
    });

    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: 's3:*',
            Condition: {
              Bool: { 'aws:SecureTransport': 'false' },
            },
          }),
        ]),
      },
    });
  });

  test('HTTP API Gateway exists with stage-aware name', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'HTTP',
      Name: 'wardrobe-api-dev',
    });
  });

  test('CloudWatch log groups exist for Lambdas and the HTTP API', () => {
    const logGroups = template.findResources('AWS::Logs::LogGroup');
    expect(Object.keys(logGroups).length).toBeGreaterThanOrEqual(7);

    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/wardrobe/dev/http-api',
      RetentionInDays: 7,
    });

    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 7,
    });
  });

  test('stack outputs ApiUrl, TableName, and MediaBucketName', () => {
    template.hasOutput('ApiUrl', {
      Description: 'HTTP API base URL',
    });
    template.hasOutput('TableName', {
      Description: 'DynamoDB table name',
    });
    template.hasOutput('MediaBucketName', {
      Description: 'S3 media bucket name',
    });
  });

  test('SQS processing queue and DLQ meet WARDROBE-15 hardening', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'wardrobe-item-processing-dev',
      VisibilityTimeout: 120,
      MessageRetentionPeriod: 345600,
      ReceiveMessageWaitTimeSeconds: 20,
      SqsManagedSseEnabled: true,
      RedrivePolicy: {
        maxReceiveCount: 3,
        deadLetterTargetArn: {
          'Fn::GetAtt': [
            Match.stringLikeRegexp('ItemProcessingDlq'),
            'Arn',
          ],
        },
      },
    });

    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'wardrobe-item-processing-dlq-dev',
      MessageRetentionPeriod: 1209600,
      SqsManagedSseEnabled: true,
      RedrivePolicy: Match.absent(),
    });

    const queuePolicies = Object.values(
      template.findResources('AWS::SQS::QueuePolicy'),
    ) as Array<{
      Properties: { PolicyDocument: { Statement: Array<{ Effect?: string }> } };
    }>;
    expect(queuePolicies.length).toBeGreaterThanOrEqual(2);
    for (const policy of queuePolicies) {
      expect(policy.Properties.PolicyDocument.Statement).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Effect: 'Deny',
            Action: 'sqs:*',
            Condition: {
              Bool: { 'aws:SecureTransport': 'false' },
            },
          }),
        ]),
      );
    }
  });

  test('CloudWatch alarms cover DLQ depth, queue depth, and oldest message age', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'wardrobe-item-processing-dlq-dev',
      AlarmDescription: 'Processing dead-letter queue contains messages',
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Namespace: 'AWS/SQS',
      Threshold: 1,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'wardrobe-item-processing-depth-dev',
      AlarmDescription: 'Processing queue approximate depth is high',
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Namespace: 'AWS/SQS',
      Threshold: 25,
      EvaluationPeriods: 5,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'wardrobe-item-processing-oldest-dev',
      AlarmDescription: 'Oldest message in the processing queue exceeds age threshold',
      MetricName: 'ApproximateAgeOfOldestMessage',
      Namespace: 'AWS/SQS',
      Threshold: 300,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  test('SQS is not exposed on the HTTP API to Flutter', () => {
    const routes = Object.values(
      template.findResources('AWS::ApiGatewayV2::Route'),
    ) as Array<{ Properties: { RouteKey: string } }>;
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route.Properties.RouteKey).not.toMatch(/sqs|queue|processing/i);
    }

    const integrations = Object.values(
      template.findResources('AWS::ApiGatewayV2::Integration'),
    ) as Array<{
      Properties: { IntegrationUri?: string; IntegrationType?: string };
    }>;
    expect(integrations.length).toBeGreaterThan(0);
    for (const integration of integrations) {
      expect(JSON.stringify(integration)).not.toMatch(/sqs/i);
    }

    template.hasOutput('ProcessingQueueUrl', {
      Description: 'Item processing queue URL',
    });
    const outputs = template.toJSON().Outputs as Record<
      string,
      { Export?: unknown }
    >;
    expect(outputs.ProcessingQueueUrl?.Export).toBeUndefined();
  });

  test('SQS IAM stays least privilege: items send, worker consume, APIs do not', () => {
    type PolicyResource = {
      Properties: {
        PolicyDocument: {
          Statement: Array<{
            Action?: string | string[];
            Effect?: string;
            Resource?: unknown;
          }>;
        };
        Roles?: unknown[];
      };
    };

    const policies = Object.values(
      template.findResources('AWS::IAM::Policy'),
    ) as PolicyResource[];

    const sqsActions = (policy: PolicyResource): string[] =>
      policy.Properties.PolicyDocument.Statement.flatMap((statement) => {
        const actions = statement.Action;
        const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
        return list.filter((action) => action.startsWith('sqs:'));
      });

    const sqsActionsFor = (fnId: string): string[] =>
      policies
        .filter((policy) => JSON.stringify(policy).includes(fnId))
        .flatMap(sqsActions);

    const itemsSqs = sqsActionsFor('ItemsFn');
    const processingSqs = sqsActionsFor('ProcessingFn');

    expect(itemsSqs).toEqual(expect.arrayContaining(['sqs:SendMessage']));
    expect(itemsSqs).not.toContain('sqs:ReceiveMessage');
    expect(itemsSqs).not.toContain('sqs:DeleteMessage');
    expect(itemsSqs).not.toContain('sqs:*');

    expect(processingSqs).toEqual(
      expect.arrayContaining([
        'sqs:ReceiveMessage',
        'sqs:DeleteMessage',
        'sqs:ChangeMessageVisibility',
        'sqs:GetQueueAttributes',
        'sqs:GetQueueUrl',
      ]),
    );
    expect(processingSqs).not.toContain('sqs:SendMessage');
    expect(processingSqs).not.toContain('sqs:*');

    for (const fnId of [
      'HealthFn',
      'WardrobesFn',
      'OutfitsFn',
      'RecommendationsFn',
      'UploadsFn',
      'AuthorizerFn',
    ]) {
      expect(sqsActionsFor(fnId)).toEqual([]);
    }

    const eventSources = template.findResources('AWS::Lambda::EventSourceMapping');
    expect(Object.keys(eventSources).length).toBe(1);
  });

  test('ProcessingFn timeout stays below SQS visibility (retries / DLQ)', () => {
    const functions = Object.values(
      template.findResources('AWS::Lambda::Function'),
    ) as Array<{
      Properties: {
        Timeout?: number;
        MemorySize?: number;
      };
    }>;

    const processing = functions.find(
      (fn) => fn.Properties.Timeout === 60 && fn.Properties.MemorySize === 512,
    );
    expect(processing).toBeDefined();

    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'wardrobe-item-processing-dev',
      VisibilityTimeout: 120,
      RedrivePolicy: {
        maxReceiveCount: 3,
        deadLetterTargetArn: {
          'Fn::GetAtt': [
            Match.stringLikeRegexp('ItemProcessingDlq'),
            'Arn',
          ],
        },
      },
    });

    expect(processing?.Properties.Timeout).toBeLessThan(120);
  });

  test('ProcessingFn IAM is least privilege for Get/Update and S3 read+write', () => {
    type PolicyResource = {
      Properties: {
        PolicyDocument: {
          Statement: Array<{
            Action?: string | string[];
            Effect?: string;
          }>;
        };
      };
    };

    const policies = Object.values(
      template.findResources('AWS::IAM::Policy'),
    ) as PolicyResource[];

    const actionsFor = (fnId: string, prefix: string): string[] =>
      policies
        .filter((policy) => JSON.stringify(policy).includes(fnId))
        .flatMap((policy) =>
          policy.Properties.PolicyDocument.Statement.flatMap((statement) => {
            const actions = statement.Action;
            const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
            return list.filter((action) => action.startsWith(prefix));
          }),
        );

    const dynamo = actionsFor('ProcessingFn', 'dynamodb:');
    expect(dynamo).toEqual(
      expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:UpdateItem']),
    );
    expect(dynamo).not.toContain('dynamodb:PutItem');
    expect(dynamo).not.toContain('dynamodb:DeleteItem');
    expect(dynamo).not.toContain('dynamodb:Query');
    expect(dynamo).not.toContain('dynamodb:Scan');
    expect(dynamo).not.toContain('dynamodb:*');

    const s3 = actionsFor('ProcessingFn', 's3:');
    expect(s3.some((action) => action.startsWith('s3:Get'))).toBe(true);
    expect(s3.some((action) => action === 's3:PutObject' || action === 's3:PutObject*')).toBe(
      true,
    );
    expect(s3).not.toContain('s3:DeleteObject');
    expect(s3).not.toContain('s3:*');

    const secrets = actionsFor('ProcessingFn', 'secretsmanager:');
    expect(secrets).toEqual(
      expect.arrayContaining(['secretsmanager:GetSecretValue']),
    );
    expect(secrets).not.toContain('secretsmanager:*');
  });

  test('stack does not introduce EventBridge', () => {
    expect(template.findResources('AWS::Events::Rule')).toEqual({});
    expect(template.findResources('AWS::Events::EventBus')).toEqual({});
    expect(JSON.stringify(template.toJSON())).not.toMatch(/AWS::Events::/);
  });

  test('stage suffix is applied to queue and alarm names', () => {
    const staging = synthTemplate('staging');
    staging.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'wardrobe-item-processing-staging',
    });
    staging.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'wardrobe-item-processing-dlq-staging',
    });
    staging.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'wardrobe-item-processing-dlq-staging',
    });
    staging.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'wardrobe-item-processing-depth-staging',
    });
    staging.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'wardrobe-item-processing-oldest-staging',
    });
  });

  test('Firebase project ID is a Secrets Manager placeholder (no real credentials)', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/dev/firebase-project-id',
    });

    const synthesized = JSON.stringify(template.toJSON());
    expect(synthesized).not.toMatch(/AIza[0-9A-Za-z_-]{35}/);
    expect(synthesized).not.toMatch(/BEGIN (RSA )?PRIVATE KEY/);
    expect(synthesized).not.toMatch(/firebase-adminsdk/);
  });

  test('Gemini background-removal credentials are a Secrets Manager placeholder (no real credentials)', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/dev/gemini-background-removal',
    });
    template.resourceCountIs('AWS::SecretsManager::Secret', 5);

    template.hasOutput('BackgroundRemovalSecretName', {
      Description:
        'Secrets Manager secret for Gemini background-removal credentials (API key, optional model/endpoint)',
    });

    const functions = Object.values(
      template.findResources('AWS::Lambda::Function'),
    ) as Array<{
      Properties: {
        Timeout?: number;
        Environment?: { Variables?: Record<string, unknown> };
      };
    }>;
    const processing = functions.find((fn) => fn.Properties.Timeout === 60);
    expect(processing?.Properties.Environment?.Variables).toEqual(
      expect.objectContaining({
        BACKGROUND_REMOVAL_SECRET_ARN: expect.anything(),
      }),
    );
    expect(processing?.Properties.Environment?.Variables).not.toHaveProperty(
      'BACKGROUND_REMOVAL_API_KEY',
    );
    expect(processing?.Properties.Environment?.Variables).not.toHaveProperty(
      'BACKGROUND_REMOVAL_ENDPOINT',
    );
    expect(processing?.Properties.Environment?.Variables).not.toHaveProperty(
      'GEMINI_API_KEY',
    );

    const synthesized = JSON.stringify(template.toJSON());
    expect(synthesized).not.toContain('background-removal-api-key');
    expect(synthesized).not.toMatch(/sk_live_/);
    expect(synthesized).not.toMatch(/AIza[0-9A-Za-z_-]{35}/);
    expect(synthesized).not.toMatch(/remove\.bg\/[A-Za-z0-9]{10,}/);
  });

  test('AI classifier credentials are a Secrets Manager placeholder granted to ProcessingFn', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/dev/gemini-classifier',
    });

    template.hasOutput('AiClassifierSecretName', {
      Description:
        'Secrets Manager secret for Gemini garment-classification credentials (API key, optional model/endpoint)',
    });

    const functions = Object.values(
      template.findResources('AWS::Lambda::Function'),
    ) as Array<{
      Properties: {
        Timeout?: number;
        MemorySize?: number;
        Environment?: { Variables?: Record<string, unknown> };
      };
    }>;
    const processing = functions.find(
      (fn) => fn.Properties.Timeout === 60 && fn.Properties.MemorySize === 512,
    );
    expect(processing?.Properties.Environment?.Variables?.AI_CLASSIFIER_SECRET_ARN).toBeDefined();
    expect(processing?.Properties.Environment?.Variables).toEqual(
      expect.objectContaining({
        BACKGROUND_REMOVAL_SECRET_ARN: expect.anything(),
        AI_CLASSIFIER_SECRET_ARN: expect.anything(),
        AI_COLOUR_DETECTOR_SECRET_ARN: expect.anything(),
      }),
    );

    type PolicyResource = {
      Properties: {
        PolicyDocument: {
          Statement: Array<{
            Action?: string | string[];
            Effect?: string;
          }>;
        };
      };
    };
    const policies = Object.values(
      template.findResources('AWS::IAM::Policy'),
    ) as PolicyResource[];
    const secretActions = policies
      .filter((policy) => JSON.stringify(policy).includes('ProcessingFn'))
      .flatMap((policy) =>
        policy.Properties.PolicyDocument.Statement.flatMap((statement) => {
          const actions = statement.Action;
          const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
          return list.filter((action) => action.startsWith('secretsmanager:'));
        }),
      );
    expect(secretActions).toEqual(
      expect.arrayContaining(['secretsmanager:GetSecretValue']),
    );

    expect(processing?.Properties.Environment?.Variables).not.toHaveProperty(
      'GEMINI_CLASSIFIER_MODEL',
    );
    expect(processing?.Properties.Environment?.Variables).not.toHaveProperty(
      'GEMINI_API_KEY',
    );

    const synthesized = JSON.stringify(template.toJSON());
    expect(synthesized).not.toContain('wardrobe/dev/ai-classifier');
    expect(synthesized).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(synthesized).not.toMatch(/OPENAI_API_KEY\s*[:=]/);
    expect(synthesized).not.toMatch(/AIza[0-9A-Za-z_-]{35}/);
  });

  test('AI colour detector credentials are a Secrets Manager placeholder granted to ProcessingFn', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/dev/ai-colour-detector',
    });

    template.hasOutput('AiColourDetectorSecretName', {
      Description:
        'Secrets Manager secret for colour detection API credentials (placeholder until replaced)',
    });

    const functions = Object.values(
      template.findResources('AWS::Lambda::Function'),
    ) as Array<{
      Properties: {
        Timeout?: number;
        MemorySize?: number;
        Environment?: { Variables?: Record<string, unknown> };
      };
    }>;
    const processing = functions.find(
      (fn) => fn.Properties.Timeout === 60 && fn.Properties.MemorySize === 512,
    );
    expect(
      processing?.Properties.Environment?.Variables?.AI_COLOUR_DETECTOR_SECRET_ARN,
    ).toBeDefined();
    expect(processing?.Properties.Environment?.Variables).not.toHaveProperty(
      'AI_COLOUR_DETECTOR_API_KEY',
    );

    const synthesized = JSON.stringify(template.toJSON());
    expect(synthesized).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(synthesized).not.toMatch(/OPENAI_API_KEY\s*[:=]/);
  });

  test('recommendations route is owner-auth and uses a dedicated read-only Lambda', () => {
    const routes = Object.values(
      template.findResources('AWS::ApiGatewayV2::Route'),
    ) as Array<{
      Properties: { RouteKey: string; AuthorizationType?: string };
    }>;
    const recommendations = routes.find(
      (route) => route.Properties.RouteKey === 'GET /wardrobes/{wardrobeId}/recommendations',
    );
    expect(recommendations?.Properties.AuthorizationType).toBe('CUSTOM');

    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/dev/ai-recommender',
      Description: Match.stringLikeRegexp('OpenAI'),
    });
    template.hasOutput('AiRecommenderSecretName', {
      Description:
        'Secrets Manager secret for OpenAI outfit-recommender credentials (placeholder until replaced)',
    });

    type PolicyResource = {
      Properties: {
        PolicyDocument: {
          Statement: Array<{
            Action?: string | string[];
            Effect?: string;
          }>;
        };
      };
    };
    const policies = Object.values(
      template.findResources('AWS::IAM::Policy'),
    ) as PolicyResource[];
    const actionsFor = (prefix: string): string[] =>
      policies
        .filter((policy) => JSON.stringify(policy).includes('RecommendationsFn'))
        .flatMap((policy) =>
          policy.Properties.PolicyDocument.Statement.flatMap((statement) => {
            const actions = statement.Action;
            const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
            return list.filter((action) => action.startsWith(prefix));
          }),
        );

    const dynamo = actionsFor('dynamodb:');
    expect(dynamo).toEqual(
      expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:Query']),
    );
    expect(dynamo).not.toContain('dynamodb:PutItem');
    expect(dynamo).not.toContain('dynamodb:UpdateItem');
    expect(dynamo).not.toContain('dynamodb:DeleteItem');
    expect(dynamo).not.toContain('dynamodb:*');

    const secrets = actionsFor('secretsmanager:');
    expect(secrets).toEqual(
      expect.arrayContaining(['secretsmanager:GetSecretValue']),
    );
    expect(secrets).not.toContain('secretsmanager:*');

    const functions = Object.values(
      template.findResources('AWS::Lambda::Function'),
    ) as Array<{
      Properties: {
        Timeout?: number;
        Environment?: { Variables?: Record<string, unknown> };
      };
    }>;
    const recommendationsFn = functions.find(
      (fn) => fn.Properties.Environment?.Variables?.AI_RECOMMENDER_SECRET_ARN,
    );
    expect(recommendationsFn).toBeDefined();
    expect(recommendationsFn?.Properties.Timeout).toBe(15);
    expect(recommendationsFn?.Properties.Environment?.Variables).toEqual(
      expect.objectContaining({
        RECOMMENDER_STRATEGY: 'openai',
        AI_RECOMMENDER_SECRET_ARN: expect.anything(),
      }),
    );
    expect(recommendationsFn?.Properties.Environment?.Variables).not.toHaveProperty(
      'AI_RECOMMENDER_API_KEY',
    );
    expect(recommendationsFn?.Properties.Environment?.Variables).not.toHaveProperty(
      'OPENAI_API_KEY',
    );

    const synthesized = JSON.stringify(template.toJSON());
    expect(synthesized).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(synthesized).not.toMatch(/OPENAI_API_KEY\s*[:=]/);
  });

  test('recommender strategy can be overridden to rules via CDK context', () => {
    const rules = synthTemplate('dev-rules', { recommenderStrategy: 'rules' });
    const functions = Object.values(
      rules.findResources('AWS::Lambda::Function'),
    ) as Array<{
      Properties: { Environment?: { Variables?: Record<string, unknown> } };
    }>;
    const recommendationsFn = functions.find(
      (fn) => fn.Properties.Environment?.Variables?.AI_RECOMMENDER_SECRET_ARN,
    );
    expect(recommendationsFn?.Properties.Environment?.Variables).toEqual(
      expect.objectContaining({
        RECOMMENDER_STRATEGY: 'rules',
      }),
    );
  });

  test('media bucket CORS stays PUT/GET only and is not a public website', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      WebsiteConfiguration: Match.absent(),
      CorsConfiguration: {
        CorsRules: [
          Match.objectLike({
            AllowedMethods: ['PUT', 'GET'],
            AllowedOrigins: ['*'],
            AllowedHeaders: ['*'],
            ExposedHeaders: ['ETag'],
            MaxAge: 3000,
          }),
        ],
      },
    });

    const buckets = Object.values(
      template.findResources('AWS::S3::Bucket'),
    ) as Array<{ Properties?: { AccessControl?: string } }>;
    for (const bucket of buckets) {
      expect(bucket.Properties?.AccessControl).toBeUndefined();
    }
  });

  test('protected routes use the Firebase Lambda authorizer; /health stays public', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      Name: 'firebase-dev',
      AuthorizerType: 'REQUEST',
      IdentitySource: ['$request.header.Authorization'],
    });

    const routes = Object.values(
      template.findResources('AWS::ApiGatewayV2::Route'),
    ) as Array<{
      Properties: { RouteKey: string; AuthorizationType?: string };
    }>;

    const health = routes.find((route) => route.Properties.RouteKey === 'GET /health');
    expect(health?.Properties.AuthorizationType ?? 'NONE').toBe('NONE');

    for (const routeKey of [
      'GET /wardrobes',
      'POST /wardrobes',
      'GET /wardrobes/{wardrobeId}',
      'PATCH /wardrobes/{wardrobeId}',
      'DELETE /wardrobes/{wardrobeId}',
      'POST /uploads',
      'GET /wardrobes/{wardrobeId}/items',
      'POST /wardrobes/{wardrobeId}/items',
      'GET /wardrobes/{wardrobeId}/items/{itemId}',
      'PATCH /wardrobes/{wardrobeId}/items/{itemId}',
      'DELETE /wardrobes/{wardrobeId}/items/{itemId}',
      'GET /wardrobes/{wardrobeId}/outfits',
      'POST /wardrobes/{wardrobeId}/outfits',
      'GET /wardrobes/{wardrobeId}/outfits/{outfitId}',
      'PATCH /wardrobes/{wardrobeId}/outfits/{outfitId}',
      'DELETE /wardrobes/{wardrobeId}/outfits/{outfitId}',
      'GET /wardrobes/{wardrobeId}/recommendations',
    ]) {
      const route = routes.find((candidate) => candidate.Properties.RouteKey === routeKey);
      expect(route?.Properties.AuthorizationType).toBe('CUSTOM');
    }
  });
});
