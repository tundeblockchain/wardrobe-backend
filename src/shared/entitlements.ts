import { getItem, keys, putItem, queryByPk } from './dynamodb';
import { Errors } from './errors';
import { nowIso } from './ids';
import {
  DynamoItem,
  Entitlement,
  EntitlementFeatures,
  EntitlementPeriod,
  EntitlementStatus,
  EntitlementStore,
  FREE_CATALOG_LIMITS,
  SUBSCRIPTION_TIERS,
  SubscriptionTier,
} from './types';

export type CatalogKind = 'wardrobe' | 'item' | 'outfit';

export const GRANTING_SUPERWALL_EVENTS = new Set([
  'initial_purchase',
  'renewal',
  'uncancellation',
  'product_change',
  'non_renewing_purchase',
]);

export const REVOKING_SUPERWALL_EVENTS = new Set(['expiration']);

/** Product ID → tier. Operator-filled in Secrets Manager. Never hardcoded. */
export type ProductTierMap = Record<string, SubscriptionTier>;

export interface StoredEntitlement {
  userId: string;
  tier: SubscriptionTier;
  status: EntitlementStatus;
  productId?: string;
  store?: EntitlementStore;
  period?: EntitlementPeriod;
  expiresAt?: string;
  originalTransactionId?: string;
  lastEventId?: string;
  lastEventAt?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SuperwallEventData {
  id?: unknown;
  name?: unknown;
  productId?: unknown;
  newProductId?: unknown;
  originalAppUserId?: unknown;
  originalTransactionId?: unknown;
  store?: unknown;
  expirationAt?: unknown;
  purchasedAt?: unknown;
  price?: unknown;
  userAttributes?: unknown;
}

export interface SuperwallWebhookEvent {
  type?: unknown;
  data?: SuperwallEventData;
}

/**
 * Resolve the caller's current tier. Missing row, expired `expiresAt`,
 * or unknown stored values all become FREE. Dynamo is the source of
 * truth — Firebase custom claims are not read in this MVP.
 */
export async function resolveEntitlement(
  userId: string,
  nowMs: number = Date.now(),
): Promise<StoredEntitlement> {
  const row = await getItem(keys.userPk(userId), keys.entitlementSk);
  if (!row || row.entityType !== 'ENTITLEMENT') {
    return freeEntitlement(userId);
  }
  return effectiveEntitlement(fromDynamo(row), nowMs);
}

export function featuresForTier(tier: SubscriptionTier): EntitlementFeatures {
  return {
    unlimitedCatalog: tier !== 'FREE',
    aiTryOn: tier === 'PREMIUM',
    otherAi: tier === 'PREMIUM',
  };
}

export function toEntitlementDto(
  stored: StoredEntitlement,
  usage: Entitlement['usage'],
): Entitlement {
  const features = featuresForTier(stored.tier);
  const dto: Entitlement = {
    userId: stored.userId,
    tier: stored.tier,
    status: stored.status,
    features,
    limits: stored.tier === 'FREE' ? { ...FREE_CATALOG_LIMITS } : null,
    usage,
    updatedAt: stored.updatedAt,
  };
  if (stored.productId) {
    dto.productId = stored.productId;
  }
  if (stored.store) {
    dto.store = stored.store;
  }
  if (stored.period) {
    dto.period = stored.period;
  }
  if (stored.expiresAt) {
    dto.expiresAt = stored.expiresAt;
  }
  return dto;
}

export async function countUsage(userId: string): Promise<Entitlement['usage']> {
  const wardrobes = await listOwnedWardrobes(userId);
  let items = 0;
  let outfits = 0;
  for (const wardrobe of wardrobes) {
    const wardrobeId = String(wardrobe.wardrobeId ?? '');
    if (!wardrobeId) {
      continue;
    }
    const children = await queryByPk(keys.wardrobePk(wardrobeId));
    for (const child of children) {
      if (child.userId !== userId) {
        continue;
      }
      if (child.entityType === 'ITEM') {
        items += 1;
      } else if (child.entityType === 'OUTFIT') {
        outfits += 1;
      }
    }
  }
  return { wardrobes: wardrobes.length, items, outfits };
}

export async function assertCanCreateCatalog(
  userId: string,
  kind: CatalogKind,
): Promise<StoredEntitlement> {
  const entitlement = await resolveEntitlement(userId);
  if (entitlement.tier !== 'FREE') {
    return entitlement;
  }

  const usage = await countUsage(userId);
  if (kind === 'wardrobe' && usage.wardrobes >= FREE_CATALOG_LIMITS.wardrobes) {
    throw Errors.wardrobeLimit();
  }
  if (kind === 'item' && usage.items >= FREE_CATALOG_LIMITS.items) {
    throw Errors.itemLimit();
  }
  if (kind === 'outfit' && usage.outfits >= FREE_CATALOG_LIMITS.outfits) {
    throw Errors.outfitLimit();
  }
  return entitlement;
}

export async function assertPremiumAi(userId: string): Promise<StoredEntitlement> {
  const entitlement = await resolveEntitlement(userId);
  if (entitlement.tier !== 'PREMIUM') {
    throw Errors.aiRequired();
  }
  return entitlement;
}

export function isPremium(entitlement: StoredEntitlement): boolean {
  return entitlement.tier === 'PREMIUM';
}

/**
 * Map a store product ID to a tier.
 *
 * 1. Operator `productTiers` map (Secrets Manager) — preferred
 * 2. Case-insensitive `premium` / `basic` substring heuristic
 * 3. Paid grant with no mapping → BASIC (unlimited catalog, no AI)
 */
export function mapProductToTier(
  productId: string | undefined,
  productTiers: ProductTierMap,
  options: { paidGrant?: boolean } = {},
): SubscriptionTier | undefined {
  if (productId) {
    const configured = productTiers[productId];
    if (configured && isTier(configured)) {
      return configured;
    }
    const lower = productId.toLowerCase();
    if (lower.includes('premium')) {
      return 'PREMIUM';
    }
    if (lower.includes('basic')) {
      return 'BASIC';
    }
  }
  if (options.paidGrant) {
    return 'BASIC';
  }
  return undefined;
}

export function applySuperwallEvent(options: {
  existing?: StoredEntitlement;
  userId: string;
  eventName: string;
  productId?: string;
  productTiers: ProductTierMap;
  store?: string;
  expirationAtMs?: number;
  originalTransactionId?: string;
  eventId?: string;
  eventAtMs?: number;
  nowIso?: string;
}): { stored: StoredEntitlement; skipped: boolean } {
  const timestamp = options.nowIso ?? nowIso();
  const existing = options.existing;
  if (
    options.eventId &&
    existing?.lastEventId &&
    existing.lastEventId === options.eventId
  ) {
    return { stored: existing, skipped: true };
  }
  if (
    typeof options.eventAtMs === 'number' &&
    typeof existing?.lastEventAt === 'number' &&
    options.eventAtMs < existing.lastEventAt
  ) {
    return { stored: existing, skipped: true };
  }

  const base = existing ?? freeEntitlement(options.userId, timestamp);
  const productId = options.productId?.trim() || undefined;
  const expiresAt =
    typeof options.expirationAtMs === 'number' &&
    Number.isFinite(options.expirationAtMs)
      ? new Date(options.expirationAtMs).toISOString()
      : base.expiresAt;
  const store = normalizeStore(options.store) ?? base.store;
  const period = inferPeriod(productId) ?? base.period;
  const originalTransactionId =
    options.originalTransactionId?.trim() || base.originalTransactionId;

  let tier = base.tier;
  let status: EntitlementStatus = base.status;

  if (GRANTING_SUPERWALL_EVENTS.has(options.eventName)) {
    tier =
      mapProductToTier(productId, options.productTiers, { paidGrant: true }) ??
      (base.tier === 'FREE' ? 'BASIC' : base.tier);
    status = 'ACTIVE';
  } else if (REVOKING_SUPERWALL_EVENTS.has(options.eventName)) {
    tier = 'FREE';
    status = 'EXPIRED';
  } else if (options.eventName === 'cancellation') {
    status = 'CANCELED';
  } else if (options.eventName === 'billing_issue') {
    status = 'BILLING_ISSUE';
  } else if (options.eventName === 'subscription_paused') {
    status = 'PAUSED';
  }

  const stored: StoredEntitlement = {
    ...base,
    userId: options.userId,
    tier,
    status,
    productId: productId ?? base.productId,
    store,
    period,
    expiresAt: status === 'EXPIRED' ? expiresAt ?? timestamp : expiresAt,
    originalTransactionId,
    lastEventId: options.eventId ?? base.lastEventId,
    lastEventAt: options.eventAtMs ?? base.lastEventAt,
    updatedAt: timestamp,
  };

  return { stored, skipped: false };
}

export async function loadStoredEntitlement(
  userId: string,
): Promise<StoredEntitlement | undefined> {
  const row = await getItem(keys.userPk(userId), keys.entitlementSk);
  return storedEntitlementFromRow(row);
}

export function storedEntitlementFromRow(
  item: DynamoItem | undefined,
): StoredEntitlement | undefined {
  if (!item || item.entityType !== 'ENTITLEMENT') {
    return undefined;
  }
  return fromDynamo(item);
}

export async function persistEntitlement(
  stored: StoredEntitlement,
): Promise<void> {
  const item: DynamoItem = {
    PK: keys.userPk(stored.userId),
    SK: keys.entitlementSk,
    entityType: 'ENTITLEMENT',
    userId: stored.userId,
    tier: stored.tier,
    status: stored.status,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
  if (stored.productId) {
    item.productId = stored.productId;
  }
  if (stored.store) {
    item.store = stored.store;
  }
  if (stored.period) {
    item.period = stored.period;
  }
  if (stored.expiresAt) {
    item.expiresAt = stored.expiresAt;
  }
  if (stored.originalTransactionId) {
    item.originalTransactionId = stored.originalTransactionId;
  }
  if (stored.lastEventId) {
    item.lastEventId = stored.lastEventId;
  }
  if (typeof stored.lastEventAt === 'number') {
    item.lastEventAt = stored.lastEventAt;
  }
  await putItem(item);
}

export function resolveSuperwallUserId(
  data: SuperwallEventData | undefined,
): string | undefined {
  if (!data) {
    return undefined;
  }
  const fromAlias = sanitizeAppUserId(data.originalAppUserId);
  if (fromAlias) {
    return fromAlias;
  }
  const attrs = asStringRecord(data.userAttributes);
  return firstNonEmpty(
    attrs.firebaseUid,
    attrs.firebase_uid,
    attrs.userId,
    attrs.user_id,
    attrs.appUserId,
    attrs.app_user_id,
  );
}

export function superwallEventName(event: SuperwallWebhookEvent): string {
  const fromData = typeof event.data?.name === 'string' ? event.data.name.trim() : '';
  if (fromData) {
    return fromData;
  }
  return typeof event.type === 'string' ? event.type.trim() : '';
}

export function parseProductTiers(value: unknown): ProductTierMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const mapped: ProductTierMap = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim() || !isTier(raw) || raw === 'FREE') {
      continue;
    }
    mapped[key.trim()] = raw;
  }
  return mapped;
}

function listOwnedWardrobes(userId: string) {
  return queryByPk(keys.userPk(userId), 'WARDROBE#').then((items) =>
    items.filter((item) => item.entityType === 'WARDROBE' && item.userId === userId),
  );
}

function freeEntitlement(userId: string, timestamp = nowIso()): StoredEntitlement {
  return {
    userId,
    tier: 'FREE',
    status: 'NONE',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function effectiveEntitlement(
  stored: StoredEntitlement,
  nowMs: number,
): StoredEntitlement {
  if (stored.tier === 'FREE') {
    return stored;
  }
  if (!stored.expiresAt) {
    return stored;
  }
  const expires = Date.parse(stored.expiresAt);
  if (!Number.isFinite(expires) || expires > nowMs) {
    return stored;
  }
  return {
    ...stored,
    tier: 'FREE',
    status: 'EXPIRED',
  };
}

function fromDynamo(item: DynamoItem): StoredEntitlement {
  return {
    userId: String(item.userId),
    tier: isTier(item.tier) ? item.tier : 'FREE',
    status: isStatus(item.status) ? item.status : 'NONE',
    productId: optionalString(item.productId),
    store: isStore(item.store) ? item.store : undefined,
    period: isPeriod(item.period) ? item.period : undefined,
    expiresAt: optionalString(item.expiresAt),
    originalTransactionId: optionalString(item.originalTransactionId),
    lastEventId: optionalString(item.lastEventId),
    lastEventAt:
      typeof item.lastEventAt === 'number' ? item.lastEventAt : undefined,
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
  };
}

function sanitizeAppUserId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('$SuperwallAlias:')) {
    return undefined;
  }
  return trimmed;
}

function inferPeriod(productId: string | undefined): EntitlementPeriod | undefined {
  if (!productId) {
    return undefined;
  }
  const lower = productId.toLowerCase();
  if (lower.includes('year') || lower.includes('annual')) {
    return 'YEARLY';
  }
  if (lower.includes('month')) {
    return 'MONTHLY';
  }
  return undefined;
}

function normalizeStore(value: unknown): EntitlementStore | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const upper = value.trim().toUpperCase();
  if (upper === 'APP_STORE' || upper === 'PLAY_STORE' || upper === 'STRIPE') {
    return upper;
  }
  if (upper) {
    return 'UNKNOWN';
  }
  return undefined;
}

function isTier(value: unknown): value is SubscriptionTier {
  return (
    typeof value === 'string' &&
    (SUBSCRIPTION_TIERS as readonly string[]).includes(value)
  );
}

function isStatus(value: unknown): value is EntitlementStatus {
  return (
    value === 'NONE' ||
    value === 'ACTIVE' ||
    value === 'CANCELED' ||
    value === 'BILLING_ISSUE' ||
    value === 'PAUSED' ||
    value === 'EXPIRED'
  );
}

function isStore(value: unknown): value is EntitlementStore {
  return (
    value === 'APP_STORE' ||
    value === 'PLAY_STORE' ||
    value === 'STRIPE' ||
    value === 'UNKNOWN'
  );
}

function isPeriod(value: unknown): value is EntitlementPeriod {
  return value === 'MONTHLY' || value === 'YEARLY' || value === 'UNKNOWN';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string' && raw.trim()) {
      result[key] = raw.trim();
    }
  }
  return result;
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
