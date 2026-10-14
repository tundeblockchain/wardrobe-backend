import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import {
  resolveStripeLookupKeys,
  StripeLookupKeys,
} from '../src/shared/stripe-plans';
import {
  resolveStripeMode,
  stripeSecretName,
  StripeMode,
} from '../src/shared/stripe-config';

/**
 * Isolated WARDROBE-187 Stripe billing secrets + IAM grant helper.
 *
 * Creates separate test and live Secrets Manager secrets. Which one a
 * stage reads comes from CDK context `stripeMode` / env `STRIPE_MODE`
 * (default test). Preview and dev cannot select live, so they never
 * receive the live secret ARN or grant.
 *
 * Checkout / portal / webhook Lambdas are added in WARDROBE-189–192.
 * Call `grantStripeSecretRead` when those functions exist. Account
 * delete (`MeFn`) is granted in this story.
 */
export interface StripeSecretsProps {
  stage: string;
  removalPolicy: cdk.RemovalPolicy;
}

export interface StripeResources {
  mode: StripeMode;
  testSecret: secretsmanager.Secret;
  liveSecret: secretsmanager.Secret;
  activeSecret: secretsmanager.Secret;
  lookupKeys: StripeLookupKeys;
}

export function addStripeSecrets(
  scope: Construct,
  props: StripeSecretsProps,
): StripeResources {
  const { stage, removalPolicy } = props;
  const mode = resolveStripeModeForConstruct(scope, stage);
  const lookupKeys = resolveStripeLookupKeysForConstruct(scope);

  const testSecret = new secretsmanager.Secret(scope, 'StripeTestSecret', {
    secretName: stripeSecretName(stage, 'test'),
    description:
      'Stripe TEST credentials (WARDROBE-187). Store JSON { "secretKey", "webhookSecret" }. Replace the generated placeholder after deploy. Never commit the real key.',
    removalPolicy,
  });

  const liveSecret = new secretsmanager.Secret(scope, 'StripeLiveSecret', {
    secretName: stripeSecretName(stage, 'live'),
    description:
      'Stripe LIVE credentials (WARDROBE-187). Store JSON { "secretKey", "webhookSecret" }. Unused unless stripeMode=live on prod. Never commit the real key.',
    removalPolicy,
  });

  const activeSecret = mode === 'live' ? liveSecret : testSecret;

  new cdk.CfnOutput(scope, 'StripeMode', {
    value: mode,
    description:
      'Which Stripe secret this stage reads (test or live). Set with CDK context stripeMode or env STRIPE_MODE.',
  });

  new cdk.CfnOutput(scope, 'StripeSecretName', {
    value: activeSecret.secretName,
    description:
      'Active Stripe Secrets Manager secret for this stage (secret API key + webhook signing secret). Placeholder until replaced.',
  });

  new cdk.CfnOutput(scope, 'StripeTestSecretName', {
    value: testSecret.secretName,
    description: 'Stripe TEST-mode secret name (placeholder until replaced)',
  });

  new cdk.CfnOutput(scope, 'StripeLiveSecretName', {
    value: liveSecret.secretName,
    description: 'Stripe LIVE-mode secret name (placeholder until replaced)',
  });

  return { mode, testSecret, liveSecret, activeSecret, lookupKeys };
}

/**
 * Least-privilege read of the active Stripe secret, plus env for
 * `getStripeConfig` / `getStripeClient`. Use this for checkout, portal,
 * webhook, and account-delete Lambdas (WARDROBE-189–192).
 */
export function grantStripeSecretRead(
  fn: lambda.Function,
  secret: secretsmanager.ISecret,
  options: { mode: StripeMode; lookupKeys: StripeLookupKeys },
): void {
  secret.grantRead(fn);
  fn.addEnvironment('STRIPE_SECRET_ARN', secret.secretArn);
  fn.addEnvironment('STRIPE_MODE', options.mode);
  fn.addEnvironment(
    'STRIPE_LOOKUP_KEY_BASIC_MONTHLY',
    options.lookupKeys.basicMonthly,
  );
  fn.addEnvironment(
    'STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY',
    options.lookupKeys.premiumMonthly,
  );
}

export function resolveStripeModeForConstruct(
  scope: Construct,
  stage: string,
): StripeMode {
  const fromContext = scope.node.tryGetContext('stripeMode');
  return resolveStripeMode(stage, fromContext ?? process.env.STRIPE_MODE);
}

function resolveStripeLookupKeysForConstruct(scope: Construct): StripeLookupKeys {
  const env: NodeJS.ProcessEnv = {
    STRIPE_LOOKUP_KEY_BASIC_MONTHLY: readContextOrEnv(
      scope,
      'stripeLookupKeyBasicMonthly',
      process.env.STRIPE_LOOKUP_KEY_BASIC_MONTHLY,
    ),
    STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY: readContextOrEnv(
      scope,
      'stripeLookupKeyPremiumMonthly',
      process.env.STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY,
    ),
  };
  return resolveStripeLookupKeys(env);
}

function readContextOrEnv(
  scope: Construct,
  contextKey: string,
  envValue: string | undefined,
): string | undefined {
  const fromContext = scope.node.tryGetContext(contextKey);
  if (typeof fromContext === 'string' && fromContext.trim()) {
    return fromContext.trim();
  }
  return envValue;
}
