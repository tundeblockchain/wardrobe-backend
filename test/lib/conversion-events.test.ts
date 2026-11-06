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

type PolicyResource = {
  Properties: {
    PolicyDocument: {
      Statement: Array<{ Action?: string | string[] }>;
    };
  };
};

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

function actionsFor(
  template: Template,
  fnId: string,
  prefix: string,
): string[] {
  const policies = Object.values(
    template.findResources('AWS::IAM::Policy'),
  ) as PolicyResource[];
  return policies
    .filter((policy) => JSON.stringify(policy).includes(fnId))
    .flatMap((policy) =>
      policy.Properties.PolicyDocument.Statement.flatMap((statement) => {
        const actions = statement.Action;
        const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
        return list.filter((action) => action.startsWith(prefix));
      }),
    );
}

describe('conversion event secrets (WARDROBE-249)', () => {
  const template = synthTemplate('dev');

  test('creates Meta and TikTok secret placeholders without real tokens', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/dev/meta-capi',
      Description: Match.stringLikeRegexp('Meta Conversions API'),
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/dev/tiktok-events',
      Description: Match.stringLikeRegexp('TikTok Events API'),
    });
    template.hasOutput('MetaCapiSecretName', {
      Description: Match.stringLikeRegexp('pixelId'),
    });
    template.hasOutput('TiktokEventsSecretName', {
      Description: Match.stringLikeRegexp('pixelCode'),
    });

    const synthesized = JSON.stringify(template.toJSON());
    expect(synthesized).not.toMatch(/EAA[A-Za-z0-9]{10,}/);
    expect(synthesized).not.toMatch(/sk_live_/);
    expect(synthesized).not.toContain('accessToken":"');
  });

  test('grants read only to StripeWebhookFn and EntitlementsWebhookFn', () => {
    const webhookEnv = functionEnvById(template, 'StripeWebhookFn');
    expect(webhookEnv).toEqual(
      expect.objectContaining({
        META_CAPI_SECRET_ARN: expect.anything(),
        TIKTOK_EVENTS_SECRET_ARN: expect.anything(),
      }),
    );
    expect(webhookEnv).not.toHaveProperty('META_CAPI_ACCESS_TOKEN');
    expect(webhookEnv).not.toHaveProperty('TIKTOK_ACCESS_TOKEN');

    const superwallEnv = functionEnvById(template, 'EntitlementsWebhookFn');
    expect(superwallEnv).toEqual(
      expect.objectContaining({
        META_CAPI_SECRET_ARN: expect.anything(),
        TIKTOK_EVENTS_SECRET_ARN: expect.anything(),
        SUPERWALL_SECRET_ARN: expect.anything(),
      }),
    );

    const billingEnv = functionEnvById(template, 'BillingFn');
    expect(billingEnv).not.toHaveProperty('META_CAPI_SECRET_ARN');
    expect(billingEnv).not.toHaveProperty('TIKTOK_EVENTS_SECRET_ARN');

    expect(actionsFor(template, 'StripeWebhookFn', 'secretsmanager:')).toEqual(
      expect.arrayContaining(['secretsmanager:GetSecretValue']),
    );
    expect(
      actionsFor(template, 'EntitlementsWebhookFn', 'secretsmanager:'),
    ).toEqual(expect.arrayContaining(['secretsmanager:GetSecretValue']));

    const billingPolicies = (
      Object.values(template.findResources('AWS::IAM::Policy')) as PolicyResource[]
    ).filter((policy) => JSON.stringify(policy).includes('BillingFn'));
    expect(JSON.stringify(billingPolicies)).not.toContain('MetaCapiSecret');
    expect(JSON.stringify(billingPolicies)).not.toContain('TiktokEventsSecret');

    const functions = Object.entries(
      template.findResources('AWS::Lambda::Function'),
    ) as Array<
      [
        string,
        { Properties: { Timeout?: number } },
      ]
    >;
    const stripeTimeout = functions.find(([id]) =>
      id.includes('StripeWebhookFn'),
    )?.[1].Properties.Timeout;
    const superwallTimeout = functions.find(([id]) =>
      id.includes('EntitlementsWebhookFn'),
    )?.[1].Properties.Timeout;
    expect(stripeTimeout).toBe(20);
    expect(superwallTimeout).toBe(20);
  });

  test('stage suffix is applied to conversion secret names', () => {
    const staging = synthTemplate('staging');
    staging.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/staging/meta-capi',
    });
    staging.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/staging/tiktok-events',
    });
  });
});
