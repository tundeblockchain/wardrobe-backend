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

describe('support mail stack wiring (WARDROBE-38)', () => {
  const template = synthTemplate('dev');

  test('creates isolated Resend + support-mail secret placeholders', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/dev/resend',
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/dev/support-mail',
    });

    template.hasOutput('ResendSecretName', {
      Description: Match.stringLikeRegexp('Resend'),
    });
    template.hasOutput('SupportMailSecretName', {
      Description: Match.stringLikeRegexp('SUPPORT_FROM_EMAIL'),
    });
    template.hasOutput('SupportWebhookUrl', {
      Description: Match.stringLikeRegexp('webhook'),
    });

    const synthesized = JSON.stringify(template.toJSON());
    expect(synthesized).not.toMatch(/re_[A-Za-z0-9]{10,}/);
    expect(synthesized).not.toMatch(/whsec_[A-Za-z0-9+/=]{8,}/);
    expect(synthesized).not.toMatch(/RESEND_API_KEY\s*[:=]/);
  });

  test('outbound support routes are Firebase-auth; inbound webhook is public', () => {
    const routes = Object.values(
      template.findResources('AWS::ApiGatewayV2::Route'),
    ) as Array<{
      Properties: { RouteKey: string; AuthorizationType?: string };
    }>;

    const contact = routes.find(
      (route) => route.Properties.RouteKey === 'POST /support/contact',
    );
    const bug = routes.find(
      (route) => route.Properties.RouteKey === 'POST /support/bug',
    );
    const webhook = routes.find(
      (route) => route.Properties.RouteKey === 'POST /webhooks/resend',
    );

    expect(contact?.Properties.AuthorizationType).toBe('CUSTOM');
    expect(bug?.Properties.AuthorizationType).toBe('CUSTOM');
    expect(webhook?.Properties.AuthorizationType ?? 'NONE').toBe('NONE');
  });

  test('support Lambdas receive secret ARNs, not raw keys', () => {
    const functions = Object.values(
      template.findResources('AWS::Lambda::Function'),
    ) as Array<{
      Properties: {
        Timeout?: number;
        Environment?: { Variables?: Record<string, unknown> };
      };
    }>;

    const supportFns = functions.filter(
      (fn) => fn.Properties.Environment?.Variables?.RESEND_SECRET_ARN,
    );
    expect(supportFns.length).toBe(2);
    for (const fn of supportFns) {
      expect(fn.Properties.Timeout).toBe(15);
      expect(fn.Properties.Environment?.Variables).toEqual(
        expect.objectContaining({
          RESEND_SECRET_ARN: expect.anything(),
          SUPPORT_MAIL_SECRET_ARN: expect.anything(),
        }),
      );
      expect(fn.Properties.Environment?.Variables).not.toHaveProperty(
        'RESEND_API_KEY',
      );
      expect(fn.Properties.Environment?.Variables).not.toHaveProperty(
        'RESEND_WEBHOOK_SECRET',
      );
      expect(fn.Properties.Environment?.Variables).not.toHaveProperty(
        'SUPPORT_FROM_EMAIL',
      );
      expect(fn.Properties.Environment?.Variables).not.toHaveProperty(
        'SUPPORT_FORWARD_TO',
      );
    }
  });

  test('support Lambdas can read secrets and do not get SQS or Dynamo write', () => {
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

    for (const fnId of ['SupportFn', 'SupportWebhookFn']) {
      expect(actionsFor(fnId, 'secretsmanager:')).toEqual(
        expect.arrayContaining(['secretsmanager:GetSecretValue']),
      );
      expect(actionsFor(fnId, 'secretsmanager:')).not.toContain(
        'secretsmanager:*',
      );
      expect(actionsFor(fnId, 'sqs:')).toEqual([]);
      expect(actionsFor(fnId, 'dynamodb:')).toEqual([]);
    }
  });

  test('stage suffix is applied to support secret names', () => {
    const staging = synthTemplate('staging');
    staging.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/staging/resend',
    });
    staging.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/staging/support-mail',
    });
  });
});
