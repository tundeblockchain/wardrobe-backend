import {
  EntitlementStore,
  PAID_TIER_SOURCES,
  PAID_TIERS,
  PaidTier,
  PaidTierSource,
  PaidTierStatus,
  SUBSCRIPTION_TIERS,
  SubscriptionTier,
} from './types';

const STORE_TO_SOURCE: Record<EntitlementStore, PaidTierSource | undefined> = {
  APP_STORE: 'ios',
  PLAY_STORE: 'android',
  STRIPE: 'stripe',
  UNKNOWN: undefined,
};

const SOURCE_TO_STORE: Record<PaidTierSource, EntitlementStore> = {
  ios: 'APP_STORE',
  android: 'PLAY_STORE',
  stripe: 'STRIPE',
};

export interface PaidTierFields {
  tier: SubscriptionTier;
  source?: PaidTierSource;
  store?: EntitlementStore;
  expiresAt?: string;
  productId?: string;
  status?: string;
}

/**
 * Map Superwall / store `store` onto the paid-tier source enum.
 * `UNKNOWN` and missing values cannot be derived.
 */
export function paidTierSourceFromStore(
  store: EntitlementStore | undefined,
): PaidTierSource | undefined {
  if (!store) {
    return undefined;
  }
  return STORE_TO_SOURCE[store];
}

export function storeFromPaidTierSource(source: PaidTierSource): EntitlementStore {
  return SOURCE_TO_STORE[source];
}

export function paidTierFromSubscriptionTier(
  tier: SubscriptionTier,
): PaidTier | undefined {
  if (tier === 'BASIC') {
    return 'basic';
  }
  if (tier === 'PREMIUM') {
    return 'premium';
  }
  return undefined;
}

export function subscriptionTierFromPaidTier(tier: PaidTier): 'BASIC' | 'PREMIUM' {
  return tier === 'premium' ? 'PREMIUM' : 'BASIC';
}

export function isPaidTier(value: unknown): value is PaidTier {
  return typeof value === 'string' && (PAID_TIERS as readonly string[]).includes(value);
}

export function isPaidTierSource(value: unknown): value is PaidTierSource {
  return (
    typeof value === 'string' &&
    (PAID_TIER_SOURCES as readonly string[]).includes(value)
  );
}

export function normalizePaidTier(value: unknown): PaidTier | undefined {
  if (isPaidTier(value)) {
    return value;
  }
  if (value === 'BASIC') {
    return 'basic';
  }
  if (value === 'PREMIUM') {
    return 'premium';
  }
  return undefined;
}

export function isSubscriptionTier(value: unknown): value is SubscriptionTier {
  return (
    typeof value === 'string' &&
    (SUBSCRIPTION_TIERS as readonly string[]).includes(value)
  );
}

/**
 * Fill `source` from `store` when the persisted attribute is missing.
 * Does not invent a source for `UNKNOWN` / missing store.
 */
export function hydratePaidTierFields<T extends PaidTierFields>(
  stored: T,
): T & { source?: PaidTierSource } {
  const source = isPaidTierSource(stored.source)
    ? stored.source
    : paidTierSourceFromStore(stored.store);
  if (source === stored.source) {
    return stored;
  }
  return { ...stored, source };
}

/**
 * Public `GET /me` `paidTier` object. `null` when the effective plan is Free.
 * Soft-omits `source` / `expiresAt` when they are not known.
 */
export function toPaidTierStatus(stored: PaidTierFields): PaidTierStatus | null {
  const hydrated = hydratePaidTierFields(stored);
  const tier = paidTierFromSubscriptionTier(hydrated.tier);
  if (!tier) {
    return null;
  }
  const status: PaidTierStatus = { tier };
  if (hydrated.source) {
    status.source = hydrated.source;
  }
  if (hydrated.expiresAt) {
    status.expiresAt = hydrated.expiresAt;
  }
  return status;
}

export type PaidTierWriteReason =
  | 'created'
  | 'upgraded'
  | 'renewed'
  | 'replaced_expired';

export type PaidTierWriteDecision =
  | { action: 'apply'; reason: PaidTierWriteReason }
  | { action: 'clash'; reason: 'source_clash' };

/**
 * Clash rule (WARDROBE-188): a different source must not overwrite an
 * active paid plan. The same source may change tier or renew. An expired
 * (or Free) plan may be replaced by any source.
 *
 * "Active" matches `effectiveEntitlement`: paid BASIC/PREMIUM whose
 * `expiresAt` is missing or still in the future, including CANCELED
 * access until expiry.
 */
export function decidePaidTierWrite(options: {
  existing?: PaidTierFields;
  incoming: { tier: PaidTier; source: PaidTierSource };
  nowMs: number;
}): PaidTierWriteDecision {
  const existing = options.existing
    ? hydratePaidTierFields(options.existing)
    : undefined;
  const existingPaid = existing
    ? paidTierFromSubscriptionTier(effectivePaidTier(existing, options.nowMs))
    : undefined;

  if (!existingPaid) {
    return {
      action: 'apply',
      reason: existing && isExpiredPaid(existing, options.nowMs)
        ? 'replaced_expired'
        : 'created',
    };
  }

  if (existing?.source && existing.source !== options.incoming.source) {
    return { action: 'clash', reason: 'source_clash' };
  }

  if (existingPaid === options.incoming.tier) {
    return { action: 'apply', reason: 'renewed' };
  }
  return { action: 'apply', reason: 'upgraded' };
}

function effectivePaidTier(
  stored: PaidTierFields,
  nowMs: number,
): SubscriptionTier {
  if (stored.tier !== 'BASIC' && stored.tier !== 'PREMIUM') {
    return stored.tier;
  }
  if (!stored.expiresAt) {
    return stored.tier;
  }
  const expires = Date.parse(stored.expiresAt);
  if (!Number.isFinite(expires) || expires > nowMs) {
    return stored.tier;
  }
  return 'FREE';
}

function isExpiredPaid(stored: PaidTierFields, nowMs: number): boolean {
  if (stored.tier !== 'BASIC' && stored.tier !== 'PREMIUM') {
    return stored.status === 'EXPIRED';
  }
  return effectivePaidTier(stored, nowMs) === 'FREE';
}
