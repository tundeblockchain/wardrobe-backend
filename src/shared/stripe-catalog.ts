import { AppError, Errors } from './errors';
import { logger } from './logger';
import {
  getStripeClient,
  getStripeConfig,
  isStripeUnconfiguredError,
  StripeConfigDeps,
  StripeRuntimeConfig,
} from './stripe-config';
import { CheckoutInterval, StripeLookupKeys } from './stripe-plans';
import { PaidTier } from './types';

/** In-memory catalog TTL per Lambda instance (WARDROBE-207). Failures are not cached. */
export const BILLING_PLANS_CACHE_TTL_MS = 5 * 60 * 1000;

export type PublicBillingTier = PaidTier;

export interface PublicBillingPlan {
  tier: PublicBillingTier;
  interval: CheckoutInterval;
  lookupKey: string;
  unitAmount: number;
  currency: string;
  productName: string;
}

export interface StripeCatalogPrice {
  active?: boolean;
  lookup_key?: string | null;
  unit_amount?: number | null;
  currency?: string;
  product?: string | { name?: string | null; deleted?: boolean };
}

export interface StripeCatalogClient {
  prices: {
    list: (params: {
      lookup_keys: string[];
      active: boolean;
      expand: string[];
      limit: number;
    }) => Promise<{ data: StripeCatalogPrice[] }>;
  };
}

const PLAN_SLOTS: ReadonlyArray<{
  tier: PublicBillingTier;
  interval: CheckoutInterval;
  key: keyof StripeLookupKeys;
}> = [
  { tier: 'basic', interval: 'monthly', key: 'basicMonthly' },
  { tier: 'basic', interval: 'yearly', key: 'basicYearly' },
  { tier: 'premium', interval: 'monthly', key: 'premiumMonthly' },
  { tier: 'premium', interval: 'yearly', key: 'premiumYearly' },
];

interface CatalogCache {
  plans: PublicBillingPlan[];
  expiresAt: number;
}

let catalogCache: CatalogCache | undefined;

/** Test-only: clear the in-memory public catalog cache. */
export function resetBillingPlansCache(): void {
  catalogCache = undefined;
}

export interface ListPublicBillingPlansDeps {
  getStripeConfig?: () => Promise<StripeRuntimeConfig>;
  getStripeClient?: () => Promise<StripeCatalogClient>;
  stripeConfigDeps?: StripeConfigDeps;
  lookupKeys?: StripeLookupKeys;
  nowMs?: () => number;
  cacheTtlMs?: number;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

/**
 * Public Pricing catalog (WARDROBE-207). Resolves the four configured
 * lookup keys via Stripe `prices.list` (`active` only, `expand=data.product`).
 * Never returns price ids, secrets, or other Stripe internals.
 */
export async function listPublicBillingPlans(
  deps: ListPublicBillingPlansDeps = {},
): Promise<PublicBillingPlan[]> {
  const now = deps.nowMs?.() ?? Date.now();
  const ttl = deps.cacheTtlMs ?? BILLING_PLANS_CACHE_TTL_MS;
  if (catalogCache && catalogCache.expiresAt > now) {
    return catalogCache.plans;
  }

  try {
    const plans = await fetchPublicBillingPlans(deps);
    catalogCache = { plans, expiresAt: now + ttl };
    return plans;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    const log = deps.log ?? logger;
    log.warn('Billing plans unavailable', {
      reason: isStripeUnconfiguredError(error)
        ? 'unconfigured'
        : 'stripe_error',
    });
    throw Errors.plansUnavailable();
  }
}

async function fetchPublicBillingPlans(
  deps: ListPublicBillingPlansDeps,
): Promise<PublicBillingPlan[]> {
  const log = deps.log ?? logger;
  const configDeps = deps.stripeConfigDeps ?? { log };
  const loadConfig =
    deps.getStripeConfig ?? (() => getStripeConfig(configDeps));
  const loadClient =
    deps.getStripeClient ??
    (() => getStripeClient(configDeps) as Promise<StripeCatalogClient>);

  let config: StripeRuntimeConfig;
  try {
    config = await loadConfig();
  } catch (error) {
    log.warn('Billing plans unavailable', {
      reason: isStripeUnconfiguredError(error)
        ? 'unconfigured'
        : 'stripe_error',
    });
    throw Errors.plansUnavailable();
  }

  // Runtime config lookup keys are filled by resolveStripeLookupKeys.
  const lookupKeys = deps.lookupKeys ?? config.lookupKeys;
  const slots = PLAN_SLOTS.map((slot) => ({
    tier: slot.tier,
    interval: slot.interval,
    lookupKey: lookupKeys[slot.key],
  }));
  const keys = slots.map((slot) => slot.lookupKey);
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) {
    log.warn('Billing plans unavailable', { reason: 'invalid_lookup_keys' });
    throw Errors.plansUnavailable();
  }

  const stripe = await loadClient();
  const listed = await stripe.prices.list({
    lookup_keys: keys,
    active: true,
    expand: ['data.product'],
    limit: keys.length,
  });

  const byLookupKey = new Map<string, StripeCatalogPrice>();
  for (const price of listed.data) {
    const lookupKey = price.lookup_key?.trim();
    if (lookupKey) {
      byLookupKey.set(lookupKey, price);
    }
  }

  const plans: PublicBillingPlan[] = [];
  for (const slot of slots) {
    const price = byLookupKey.get(slot.lookupKey);
    const mapped = price ? toPublicPlan(slot, price) : undefined;
    if (!mapped) {
      log.warn('Billing plans unavailable', { reason: 'missing_or_inactive' });
      throw Errors.plansUnavailable();
    }
    plans.push(mapped);
  }

  log.info('Billing plans loaded', {
    count: plans.length,
    lookupKeys: plans.map((plan) => plan.lookupKey),
  });
  return plans;
}

function toPublicPlan(
  slot: { tier: PublicBillingTier; interval: CheckoutInterval; lookupKey: string },
  price: StripeCatalogPrice,
): PublicBillingPlan | undefined {
  if (price.active !== true) {
    return undefined;
  }
  const unitAmount = price.unit_amount;
  if (
    typeof unitAmount !== 'number' ||
    !Number.isInteger(unitAmount) ||
    unitAmount <= 0
  ) {
    return undefined;
  }
  const currency = price.currency?.trim().toLowerCase();
  if (!currency) {
    return undefined;
  }
  const productName = readProductName(price.product);
  if (!productName) {
    return undefined;
  }
  return {
    tier: slot.tier,
    interval: slot.interval,
    lookupKey: slot.lookupKey,
    unitAmount,
    currency,
    productName,
  };
}

function readProductName(
  product: StripeCatalogPrice['product'],
): string | undefined {
  if (!product || typeof product === 'string' || product.deleted) {
    return undefined;
  }
  const name = product.name?.trim();
  return name || undefined;
}
