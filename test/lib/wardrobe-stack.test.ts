import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { WardrobeStack } from '../../lib/wardrobe-stack';

jest.setTimeout(180_000);

function synthTemplate(stage = 'dev'): Template {
  const app = new cdk.App();
  const stack = new WardrobeStack(app, `WardrobeStack-${stage}`, { stage });
  return Template.fromStack(stack);
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

  test('Phase-2 SQS processing hook exists without expanding worker behavior', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'wardrobe-item-processing-dev',
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'wardrobe-item-processing-dlq-dev',
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
    ]) {
      const route = routes.find((candidate) => candidate.Properties.RouteKey === routeKey);
      expect(route?.Properties.AuthorizationType).toBe('CUSTOM');
    }
  });
});
