import Stripe from 'stripe';
import { logger } from './logger';
import { getSecretString, parseJsonObjectOrString } from './secrets';
import { looksLikePlaceholderCredential } from './superwall-config';
import {
  DEFAULT_STRIPE_LOOKUP_KEY_BASIC_MONTHLY,
  DEFAULT_STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY,
  resolveStripeLookupKeys,
  StripeLookupKeys,
  StripePriceIds,
} from './stripe-plans';

export const STRIPE_MODES = ['test', 'live'] as const;
export type StripeMode = (typeof STRIPE_MODES)[number];

/** Stages that may select the live Stripe secret. All others stay on test. */
export const STRIPE_LIVE_ALLOWED_STAGES = ['prod', 'production'] as const;

export const STRIPE_SECRET_ARN_ENV = 'STRIPE_SECRET_ARN';
export const STRIPE_MODE_ENV = 'STRIPE_MODE';

export interface StripeSecretFields {
  secretKey: string;
  webhookSecret: string;
}

export interface StripeRuntimeConfig extends StripeSecretFields {
  mode: StripeMode;
  lookupKeys: StripeLookupKeys;
  priceIds: StripePriceIds;
}

export interface StripeConfigDeps {
  env?: NodeJS.ProcessEnv;
  getSecretString?: (secretId: string) => Promise<string>;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

interface StripeClientCache {
  secretArn: string;
  client: Stripe;
}

interface StripeConfigCache {
  secretArn: string;
  config: StripeRuntimeConfig;
}

let configCache: StripeConfigCache | undefined;
let clientCache: StripeClientCache | undefined;

export function stripeSecretName(stage: string, mode: StripeMode): string {
  return `wardrobe/${stage}/stripe-${mode}`;
}

export function parseStripeMode(value: unknown): StripeMode | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'test' || normalized === 'live') {
    return normalized;
  }
  return undefined;
}

export function isStripeLiveAllowed(stage: string): boolean {
  return (STRIPE_LIVE_ALLOWED_STAGES as readonly string[]).includes(stage);
}

/**
 * Which Stripe secret a stage reads. Defaults to test.
 * Preview / dev (and any non-prod stage) cannot select live, so they
 * never receive the live secret ARN or IAM grant.
 */
export function resolveStripeMode(stage: string, requested?: unknown): StripeMode {
  const mode = parseStripeMode(requested) ?? 'test';
  if (mode === 'live' && !isStripeLiveAllowed(stage)) {
    throw new Error(
      `Stripe live mode is not allowed for stage "${stage}". Use stripeMode=test.`,
    );
  }
  return mode;
}

export function parseStripeSecret(secretString: string): StripeSecretFields {
  const parsed = parseJsonObjectOrString(secretString);
  if (typeof parsed === 'string') {
    const secretKey = parsed.trim();
    if (!secretKey) {
      throw new Error('Stripe secret is empty.');
    }
    return { secretKey, webhookSecret: '' };
  }

  const secretKey = firstString(parsed, [
    'secretKey',
    'secret_key',
    'stripeSecretKey',
    'STRIPE_SECRET_KEY',
    'apiKey',
  ]);
  const webhookSecret =
    firstString(parsed, [
      'webhookSecret',
      'webhook_secret',
      'webhookSigningSecret',
      'signingSecret',
      'STRIPE_WEBHOOK_SECRET',
    ]) ?? '';

  if (!secretKey) {
    throw new Error('Stripe secret is missing secretKey.');
  }
  return { secretKey, webhookSecret };
}

export function assertStripeKeyMatchesMode(mode: StripeMode, secretKey: string): void {
  if (mode === 'test' && secretKey.startsWith('sk_live_')) {
    throw new Error('Stripe test mode cannot use a live secret key.');
  }
  if (mode === 'live' && secretKey.startsWith('sk_test_')) {
    throw new Error('Stripe live mode cannot use a test secret key.');
  }
}

export async function getStripeConfig(
  deps: StripeConfigDeps = {},
): Promise<StripeRuntimeConfig> {
  const env = deps.env ?? process.env;
  const loadSecret = deps.getSecretString ?? getSecretString;
  const log = deps.log ?? logger;

  const secretArn = env[STRIPE_SECRET_ARN_ENV]?.trim();
  if (!secretArn) {
    throw new Error('STRIPE_SECRET_ARN is not set.');
  }

  if (configCache && configCache.secretArn === secretArn) {
    return configCache.config;
  }

  const stage = env.STAGE?.trim() || 'dev';
  const mode = resolveStripeMode(stage, env[STRIPE_MODE_ENV]);
  const secretString = await loadSecret(secretArn);
  const fields = parseStripeSecret(secretString);

  if (looksLikePlaceholderCredential(fields.secretKey)) {
    throw new Error(
      'Stripe secretKey is a placeholder; replace the Secrets Manager value.',
    );
  }
  assertStripeKeyMatchesMode(mode, fields.secretKey);

  const config: StripeRuntimeConfig = {
    mode,
    secretKey: fields.secretKey,
    webhookSecret: fields.webhookSecret,
    lookupKeys: resolveStripeLookupKeys(env),
    priceIds: {
      basicMonthly: optionalEnv(env, 'STRIPE_PRICE_ID_BASIC_MONTHLY'),
      premiumMonthly: optionalEnv(env, 'STRIPE_PRICE_ID_PREMIUM_MONTHLY'),
    },
  };

  // Mode and lookup keys only — never the secret key or webhook secret.
  log.info('Stripe config loaded', {
    mode: config.mode,
    lookupKeyBasicMonthly: config.lookupKeys.basicMonthly,
    lookupKeyPremiumMonthly: config.lookupKeys.premiumMonthly,
  });

  configCache = { secretArn, config };
  return config;
}

export async function getStripeClient(deps: StripeConfigDeps = {}): Promise<Stripe> {
  const env = deps.env ?? process.env;
  const secretArn = env[STRIPE_SECRET_ARN_ENV]?.trim() ?? '';
  if (clientCache && clientCache.secretArn === secretArn) {
    return clientCache.client;
  }

  const config = await getStripeConfig(deps);
  const client = new Stripe(config.secretKey);
  clientCache = { secretArn, client };
  return client;
}

export function resetStripeCaches(): void {
  configCache = undefined;
  clientCache = undefined;
}

export function defaultStripeLookupKeys(): StripeLookupKeys {
  return {
    basicMonthly: DEFAULT_STRIPE_LOOKUP_KEY_BASIC_MONTHLY,
    premiumMonthly: DEFAULT_STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY,
  };
}

function optionalEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function firstString(
  record: Record<string, unknown>,
  keysToTry: string[],
): string | undefined {
  for (const key of keysToTry) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
