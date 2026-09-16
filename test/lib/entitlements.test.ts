import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { WardrobeStack } from '../../lib/wardrobe-stack';

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

describe('entitlements stack wiring (WARDROBE-91)', () => {
  const template = synthTemplate('dev');

  test('creates a Superwall secret placeholder without product IDs or signing secrets', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/dev/superwall',
    });
    template.hasOutput('SuperwallSecretName', {
      Description: Match.stringLikeRegexp('Superwall'),
    });
    template.hasOutput('SuperwallWebhookUrl', {
      Description: Match.stringLikeRegexp('webhook'),
    });

    const synthesized = JSON.stringify(template.toJSON());
    expect(synthesized).not.toMatch(/whsec_[A-Za-z0-9+/=]{8,}/);
    expect(synthesized).not.toMatch(/SUPERWALL_WEBHOOK_SECRET\s*[:=]/);
    expect(synthesized).not.toContain('com.example.premium');
  });

  test('GET /me is Firebase-auth; Superwall webhook is public', () => {
    const routes = Object.values(
      template.findResources('AWS::ApiGatewayV2::Route'),
    ) as Array<{
      Properties: { RouteKey: string; AuthorizationType?: string };
    }>;

    const me = routes.find((route) => route.Properties.RouteKey === 'GET /me');
    const webhook = routes.find(
      (route) => route.Properties.RouteKey === 'POST /webhooks/superwall',
    );

    expect(me?.Properties.AuthorizationType).toBe('CUSTOM');
    expect(webhook?.Properties.AuthorizationType ?? 'NONE').toBe('NONE');
  });

  test('webhook Lambda receives the secret ARN and can write Dynamo', () => {
    type PolicyResource = {
      Properties: {
        PolicyDocument: {
          Statement: Array<{
            Action?: string | string[];
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

    expect(actionsFor('EntitlementsWebhookFn', 'secretsmanager:')).toEqual(
      expect.arrayContaining(['secretsmanager:GetSecretValue']),
    );
    expect(actionsFor('EntitlementsWebhookFn', 'dynamodb:')).toEqual(
      expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:PutItem']),
    );

    const functions = Object.values(
      template.findResources('AWS::Lambda::Function'),
    ) as Array<{
      Properties: {
        Environment?: { Variables?: Record<string, unknown> };
      };
    }>;
    const webhookFn = functions.find(
      (fn) => fn.Properties.Environment?.Variables?.SUPERWALL_SECRET_ARN,
    );
    expect(webhookFn).toBeDefined();
    expect(webhookFn?.Properties.Environment?.Variables).not.toHaveProperty(
      'SUPERWALL_WEBHOOK_SECRET',
    );
  });

  test('stage suffix is applied to the Superwall secret name', () => {
    const staging = synthTemplate('staging');
    staging.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/staging/superwall',
    });
  });
});
