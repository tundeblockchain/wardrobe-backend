import { featuresForTier } from './entitlements';
import { PaidTier, SubscriptionTier } from './types';

/**
 * Paid Stripe tiers. Limits and feature flags come from the existing
 * entitlement table (`FREE_CATALOG_LIMITS` / `featuresForTier`) — do not
 * duplicate catalog caps here.
 */
export const STRIPE_PAID_TIERS = ['BASIC', 'PREMIUM'] as const;
export type StripePaidTier = (typeof STRIPE_PAID_TIERS)[number];

export const DEFAULT_STRIPE_LOOKUP_KEY_BASIC_MONTHLY = 'wardrobe_basic_monthly';
export const DEFAULT_STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY =
  'wardrobe_premium_monthly';

/** GBP minor units. Matches the existing product matrix (£5 / £15). */
export const DEFAULT_STRIPE_UNIT_AMOUNT_BASIC_MONTHLY = 500;
export const DEFAULT_STRIPE_UNIT_AMOUNT_PREMIUM_MONTHLY = 1500;
export const DEFAULT_STRIPE_CURRENCY = 'gbp';

export interface StripeLookupKeys {
  basicMonthly: string;
  premiumMonthly: string;
}

export interface StripePriceIds {
  basicMonthly?: string;
  premiumMonthly?: string;
}

export interface StripePlanPrice {
  lookupKey: string;
  /** Optional operator override. Never default to a live Stripe price id. */
  priceId?: string;
  unitAmount: number;
  currency: string;
  interval: 'month';
}

export interface StripePlanDefinition {
  tier: StripePaidTier;
  productName: string;
  /** Entitlement features from `featuresForTier` — not a second limits table. */
  features: ReturnType<typeof featuresForTier>;
  /** Paid tiers are unlimited (`limits: null` on GET /me). */
  limits: null;
  monthly: StripePlanPrice;
}

export function resolveStripeLookupKeys(
  env: NodeJS.ProcessEnv = process.env,
): StripeLookupKeys {
  return {
    basicMonthly:
      env.STRIPE_LOOKUP_KEY_BASIC_MONTHLY?.trim() ||
      DEFAULT_STRIPE_LOOKUP_KEY_BASIC_MONTHLY,
    premiumMonthly:
      env.STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY?.trim() ||
      DEFAULT_STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY,
  };
}

export function resolveStripePlans(
  env: NodeJS.ProcessEnv = process.env,
): StripePlanDefinition[] {
  const lookupKeys = resolveStripeLookupKeys(env);
  const currency = env.STRIPE_CURRENCY?.trim().toLowerCase() || DEFAULT_STRIPE_CURRENCY;

  return [
    planDefinition('BASIC', 'Wardrobe Basic', {
      lookupKey: lookupKeys.basicMonthly,
      priceId: optionalEnv(env, 'STRIPE_PRICE_ID_BASIC_MONTHLY'),
      unitAmount: parseAmount(
        env.STRIPE_UNIT_AMOUNT_BASIC_MONTHLY,
        DEFAULT_STRIPE_UNIT_AMOUNT_BASIC_MONTHLY,
      ),
      currency,
      interval: 'month',
    }),
    planDefinition('PREMIUM', 'Wardrobe Premium', {
      lookupKey: lookupKeys.premiumMonthly,
      priceId: optionalEnv(env, 'STRIPE_PRICE_ID_PREMIUM_MONTHLY'),
      unitAmount: parseAmount(
        env.STRIPE_UNIT_AMOUNT_PREMIUM_MONTHLY,
        DEFAULT_STRIPE_UNIT_AMOUNT_PREMIUM_MONTHLY,
      ),
      currency,
      interval: 'month',
    }),
  ];
}

export function isStripePaidTier(value: string): value is StripePaidTier {
  return (STRIPE_PAID_TIERS as readonly SubscriptionTier[]).includes(
    value as SubscriptionTier,
  );
}

/** Lookup key for a checkout `basic` / `premium` body tier. */
export function stripeLookupKeyForPaidTier(
  tier: PaidTier,
  keys: StripeLookupKeys,
): string {
  return tier === 'premium' ? keys.premiumMonthly : keys.basicMonthly;
}

/** Optional operator price-id override. Never invent a live `price_…` id. */
export function stripePriceIdForPaidTier(
  tier: PaidTier,
  ids: StripePriceIds,
): string | undefined {
  const priceId = tier === 'premium' ? ids.premiumMonthly : ids.basicMonthly;
  return priceId?.trim() || undefined;
}

function planDefinition(
  tier: StripePaidTier,
  productName: string,
  monthly: StripePlanPrice,
): StripePlanDefinition {
  return {
    tier,
    productName,
    features: featuresForTier(tier),
    limits: null,
    monthly,
  };
}

function parseAmount(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) {
    return fallback;
  }
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid Stripe unit amount "${raw}".`);
  }
  return parsed;
}

function optionalEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}
