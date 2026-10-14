import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { WardrobeStack } from '../../lib/wardrobe-stack';

jest.setTimeout(180_000);

function synthTemplate(
  stage = 'dev',
  context: Record<string, string> = {},
): Template {
  const previousMode = process.env.STRIPE_MODE;
  const previousStrategy = process.env.RECOMMENDER_STRATEGY;
  const previousBgRemoval = process.env.BACKGROUND_REMOVAL_ENABLED;
  delete process.env.STRIPE_MODE;
  delete process.env.RECOMMENDER_STRATEGY;
  delete process.env.BACKGROUND_REMOVAL_ENABLED;
  try {
    const app = new cdk.App({ context });
    const stack = new WardrobeStack(app, `WardrobeStack-${stage}`, { stage });
    return Template.fromStack(stack);
  } finally {
    if (previousMode === undefined) {
      delete process.env.STRIPE_MODE;
    } else {
      process.env.STRIPE_MODE = previousMode;
    }
    if (previousStrategy === undefined) {
      delete process.env.RECOMMENDER_STRATEGY;
    } else {
      process.env.RECOMMENDER_STRATEGY = previousStrategy;
    }
    if (previousBgRemoval === undefined) {
      delete process.env.BACKGROUND_REMOVAL_ENABLED;
    } else {
      process.env.BACKGROUND_REMOVAL_ENABLED = previousBgRemoval;
    }
  }
}

type PolicyResource = {
  Properties: {
    PolicyDocument: {
      Statement: Array<{
        Action?: string | string[];
        Resource?: unknown;
      }>;
    };
    Roles?: unknown[];
  };
};

function secretActionsFor(template: Template, fnId: string): string[] {
  const policies = Object.values(
    template.findResources('AWS::IAM::Policy'),
  ) as PolicyResource[];
  return policies
    .filter((policy) => JSON.stringify(policy).includes(fnId))
    .flatMap((policy) =>
      policy.Properties.PolicyDocument.Statement.flatMap((statement) => {
        const actions = statement.Action;
        const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
        return list.filter((action) => action.startsWith('secretsmanager:'));
      }),
    );
}

function functionEnv(
  template: Template,
  predicate: (vars: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  const functions = Object.values(
    template.findResources('AWS::Lambda::Function'),
  ) as Array<{
    Properties: {
      Environment?: { Variables?: Record<string, unknown> };
    };
  }>;
  return functions.find((fn) => {
    const vars = fn.Properties.Environment?.Variables;
    return vars ? predicate(vars) : false;
  })?.Properties.Environment?.Variables;
}

describe('Stripe secrets and grants (WARDROBE-187)', () => {
  const template = synthTemplate('dev');

  test('creates separate test and live secret placeholders without values', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/dev/stripe-test',
      Description: Match.stringLikeRegexp('Stripe TEST'),
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/dev/stripe-live',
      Description: Match.stringLikeRegexp('Stripe LIVE'),
    });

    template.hasOutput('StripeMode', { Value: 'test' });
    template.hasOutput('StripeSecretName', {
      Description: Match.stringLikeRegexp('Active Stripe'),
    });
    template.hasOutput('StripeTestSecretName', {
      Description: Match.stringLikeRegexp('TEST-mode'),
    });
    template.hasOutput('StripeLiveSecretName', {
      Description: Match.stringLikeRegexp('LIVE-mode'),
    });

    const synthesized = JSON.stringify(template.toJSON());
    expect(synthesized).not.toMatch(/sk_live_/);
    expect(synthesized).not.toMatch(/sk_test_[A-Za-z0-9]{8,}/);
    expect(synthesized).not.toMatch(/whsec_[A-Za-z0-9+/=]{8,}/);
    expect(synthesized).not.toMatch(/price_1[A-Za-z0-9]{8,}/);
  });

  test('defaults the stage to the test secret and grants it only to MeFn', () => {
    const meEnv = functionEnv(
      template,
      (vars) => Boolean(vars.SUPERWALL_SECRET_ARN && vars.STRIPE_SECRET_ARN),
    );
    expect(meEnv).toBeDefined();
    expect(meEnv).toEqual(
      expect.objectContaining({
        STRIPE_MODE: 'test',
        STRIPE_LOOKUP_KEY_BASIC_MONTHLY: 'wardrobe_basic_monthly',
        STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY: 'wardrobe_premium_monthly',
        STRIPE_SECRET_ARN: expect.anything(),
      }),
    );
    expect(meEnv).not.toHaveProperty('STRIPE_SECRET_KEY');
    expect(meEnv).not.toHaveProperty('STRIPE_WEBHOOK_SECRET');

    const synthesized = JSON.stringify(template.toJSON());
    expect(synthesized).toContain('StripeTestSecret');
    expect(secretActionsFor(template, 'MeFn')).toEqual(
      expect.arrayContaining(['secretsmanager:GetSecretValue']),
    );

    const mePolicies = (
      Object.values(template.findResources('AWS::IAM::Policy')) as PolicyResource[]
    ).filter((policy) => JSON.stringify(policy).includes('MeFn'));
    expect(JSON.stringify(mePolicies)).toContain('StripeTestSecret');
    expect(JSON.stringify(mePolicies)).not.toContain('StripeLiveSecret');

    const functionsWithStripe = (
      Object.values(template.findResources('AWS::Lambda::Function')) as Array<{
        Properties: { Environment?: { Variables?: Record<string, unknown> } };
      }>
    ).filter((fn) => fn.Properties.Environment?.Variables?.STRIPE_SECRET_ARN);
    expect(functionsWithStripe).toHaveLength(1);

    for (const fnId of [
      'HealthFn',
      'ItemsFn',
      'OutfitsFn',
      'ProcessingFn',
      'EntitlementsWebhookFn',
      'AuthorizerFn',
      'UploadsFn',
      'SharesFn',
      'RecommendationsFn',
    ]) {
      const policies = (
        Object.values(template.findResources('AWS::IAM::Policy')) as PolicyResource[]
      ).filter((policy) => JSON.stringify(policy).includes(fnId));
      expect(JSON.stringify(policies)).not.toContain('StripeTestSecret');
      expect(JSON.stringify(policies)).not.toContain('StripeLiveSecret');
    }
  });

  test('API CORS stays allowOrigins *', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: ['*'],
      }),
    });
  });

  test('lookup keys can be overridden via CDK context', () => {
    const custom = synthTemplate('dev', {
      stripeLookupKeyBasicMonthly: 'basic_from_context',
      stripeLookupKeyPremiumMonthly: 'premium_from_context',
    });
    const meEnv = functionEnv(custom, (vars) => Boolean(vars.STRIPE_SECRET_ARN));
    expect(meEnv).toEqual(
      expect.objectContaining({
        STRIPE_LOOKUP_KEY_BASIC_MONTHLY: 'basic_from_context',
        STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY: 'premium_from_context',
      }),
    );
  });

  test('prod may select the live secret; other Lambdas still have no grant', () => {
    const prod = synthTemplate('prod', { stripeMode: 'live' });
    prod.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/prod/stripe-test',
    });
    prod.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/prod/stripe-live',
    });
    prod.hasOutput('StripeMode', { Value: 'live' });

    const meEnv = functionEnv(prod, (vars) => Boolean(vars.STRIPE_SECRET_ARN));
    expect(meEnv?.STRIPE_MODE).toBe('live');

    const mePolicies = (
      Object.values(prod.findResources('AWS::IAM::Policy')) as PolicyResource[]
    ).filter((policy) => JSON.stringify(policy).includes('MeFn'));
    expect(JSON.stringify(mePolicies)).toContain('StripeLiveSecret');
    expect(JSON.stringify(mePolicies)).not.toContain('StripeTestSecret');
  });

  test('preview and dev stages cannot select live mode', () => {
    expect(() => synthTemplate('dev', { stripeMode: 'live' })).toThrow(
      /Stripe live mode is not allowed for stage "dev"/,
    );
    expect(() => synthTemplate('preview-pr-9', { stripeMode: 'live' })).toThrow(
      /Stripe live mode is not allowed/,
    );
  });

  test('stage suffix is applied to both Stripe secret names', () => {
    const staging = synthTemplate('staging');
    staging.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/staging/stripe-test',
    });
    staging.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/staging/stripe-live',
    });
    staging.hasOutput('StripeMode', { Value: 'test' });
  });
});
