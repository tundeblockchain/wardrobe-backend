import { createHash } from 'crypto';
import { nanoid } from 'nanoid';
import {
  getItem,
  keys,
  putItem,
  putItemIfNotExists,
  queryByPk,
} from './dynamodb';
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
  /** Dynamo SK when loaded. Not part of the GET /me DTO. */
  sk?: string;
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
  /** StoreKit appAccountToken at first purchase. Must equal the derived id. */
  originalAppUserId?: unknown;
  /** Not part of Superwall's documented webhook `data`. Read only if a uid. */
  appUserId?: unknown;
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
 * Resolve the caller's current tier. Missing row, expired `expiresAt`
 * on the latest row, or unknown stored values all become FREE. Dynamo
 * is the source of truth — Firebase custom claims are not read in this MVP.
 *
 * Always picks the latest entitlement record (WARDROBE-159). A stale
 * expired/canceled row must not win over a newer ACTIVE paid row.
 *
 * Does not write. Catalog and AI gates use this so a user who has not
 * called `GET /me` yet is still Free.
 */
export async function resolveEntitlement(
  userId: string,
  nowMs: number = Date.now(),
): Promise<StoredEntitlement> {
  const latest = await loadStoredEntitlement(userId);
  if (!latest) {
    return freeEntitlement(userId);
  }
  return effectiveEntitlement(latest, nowMs);
}

/**
 * First sight of an account (`GET /me` on launch). Persists
 * `USER#{uid} / SK=ENTITLEMENT` as FREE / NONE when no entitlement
 * rows exist. Superwall events append new `ENTITLEMENT#{ts}#{id}`
 * rows instead of overwriting this seed. The create is conditional
 * so a subscription that lands first is kept.
 */
export async function ensureFreeEntitlement(
  userId: string,
  nowMs: number = Date.now(),
): Promise<StoredEntitlement> {
  const existing = await listStoredEntitlements(userId);
  if (existing.length > 0) {
    return effectiveEntitlement(pickLatestEntitlement(existing)!, nowMs);
  }

  const created = freeEntitlement(userId);
  await putItemIfNotExists(entitlementItem(created));

  const after = await listStoredEntitlements(userId);
  if (after.length > 0) {
    return effectiveEntitlement(pickLatestEntitlement(after)!, nowMs);
  }
  return created;
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
  /** Full history for idempotency. Defaults to `[existing]` when omitted. */
  history?: StoredEntitlement[];
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
  const history =
    options.history ?? (options.existing ? [options.existing] : []);
  if (options.eventId) {
    const duplicate = history.find((row) => row.lastEventId === options.eventId);
    if (duplicate) {
      return { stored: duplicate, skipped: true };
    }
  }

  const existing = options.existing ?? pickLatestEntitlement(history);
  if (
    typeof options.eventAtMs === 'number' &&
    typeof existing?.lastEventAt === 'number' &&
    options.eventAtMs < existing.lastEventAt
  ) {
    return { stored: existing, skipped: true };
  }

  const base = existing ?? freeEntitlement(options.userId, timestamp);
  const productId = options.productId?.trim() || undefined;
  const store = normalizeStore(options.store) ?? base.store;
  const period = inferPeriod(productId) ?? base.period;
  const originalTransactionId =
    options.originalTransactionId?.trim() || base.originalTransactionId;
  const granting = GRANTING_SUPERWALL_EVENTS.has(options.eventName);

  let tier = base.tier;
  let status: EntitlementStatus = base.status;

  if (granting) {
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

  const expiresAt = resolveEventExpiresAt({
    expirationAtMs: options.expirationAtMs,
    granting,
    expired: status === 'EXPIRED',
    period,
    inherited: base.expiresAt,
    timestamp,
  });

  const stored: StoredEntitlement = {
    ...base,
    sk: undefined,
    userId: options.userId,
    tier,
    status,
    productId: productId ?? base.productId,
    store,
    period,
    expiresAt,
    originalTransactionId,
    lastEventId: options.eventId ?? base.lastEventId,
    lastEventAt: options.eventAtMs ?? base.lastEventAt,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  return { stored, skipped: false };
}

export async function listStoredEntitlements(
  userId: string,
): Promise<StoredEntitlement[]> {
  const rows = await queryByPk(keys.userPk(userId), keys.entitlementSkPrefix);
  return rows.flatMap((row) => {
    const stored = storedEntitlementFromRow(row);
    return stored ? [stored] : [];
  });
}

export async function loadStoredEntitlement(
  userId: string,
): Promise<StoredEntitlement | undefined> {
  return pickLatestEntitlement(await listStoredEntitlements(userId));
}

export function storedEntitlementFromRow(
  item: DynamoItem | undefined,
): StoredEntitlement | undefined {
  if (!item || item.entityType !== 'ENTITLEMENT') {
    return undefined;
  }
  return fromDynamo(item);
}

/**
 * Append a Superwall entitlement row. Never overwrites `SK=ENTITLEMENT`.
 *
 * Write vs in-place (WARDROBE-159):
 * - Superwall subscribe / status-changing events → new
 *   `ENTITLEMENT#{updatedAt}#{eventId}` row (append history).
 * - `ensureFreeEntitlement` → conditional `SK=ENTITLEMENT` seed only when
 *   no entitlement rows exist. That is the only singleton write.
 */
export async function persistEntitlement(
  stored: StoredEntitlement,
): Promise<void> {
  await putItem(entitlementItem(stored, { history: true }));
}

function entitlementItem(
  stored: StoredEntitlement,
  options?: { history?: boolean },
): DynamoItem {
  const sk = options?.history
    ? keys.entitlementHistorySk(stored.updatedAt, historySkUnique(stored))
    : (stored.sk ?? keys.entitlementSk);
  const item: DynamoItem = {
    PK: keys.userPk(stored.userId),
    SK: sk,
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
  return item;
}

/** Prefix hashed with the Firebase uid by Flutter (wardrobe_app#87). */
export const SUPERWALL_APP_USER_ID_PREFIX = 'wardrobe:superwall:app-user-id:';

/**
 * Superwall `identify()` id for a Firebase uid (WARDROBE-167).
 *
 * SuperwallKit only sends `appUserId` to StoreKit as `appAccountToken`
 * (and so as the webhook's `originalAppUserId`) when it is a UUID, so
 * Flutter identifies with SHA-256(prefix + uid), first 16 bytes, with
 * the RFC 4122 version-4 and variant bits set. Must stay byte-identical
 * to the app's derivation.
 */
export function deriveSuperwallAppUserId(firebaseUid: string): string {
  const bytes = createHash('sha256')
    .update(`${SUPERWALL_APP_USER_ID_PREFIX}${firebaseUid}`, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export type SuperwallIdentity =
  | { status: 'ok'; userId: string }
  | { status: 'unknown_user' }
  | { status: 'ambiguous_user' }
  | { status: 'app_user_id_mismatch' };

/**
 * Firebase uid that paid for this Superwall event (WARDROBE-167).
 *
 * `userAttributes.firebaseUid` (or `firebase_uid`) is only the candidate
 * to hash. The grant is proven by `originalAppUserId` — the StoreKit
 * `appAccountToken` fixed at purchase — equalling that uid's derived
 * Superwall id (case-insensitive). A device UUID, `$SuperwallAlias:` or
 * a pre-derivation purchase never matches, so it grants nobody. There is
 * no fallback to `userAttributes` alone, `appUserId` or the receipt owner.
 */
export function resolveSuperwallIdentity(
  data: SuperwallEventData | undefined,
): SuperwallIdentity {
  if (!data) {
    return { status: 'unknown_user' };
  }
  const attrs = parseUserAttributes(data.userAttributes);
  const candidates = new Set<string>();
  for (const value of [attrs.firebaseUid, attrs.firebase_uid]) {
    const uid = optionalString(value);
    if (uid) {
      candidates.add(uid);
    }
  }
  if (candidates.size === 0) {
    return { status: 'unknown_user' };
  }
  if (candidates.size > 1) {
    return { status: 'ambiguous_user' };
  }

  const [uid] = [...candidates];
  const original = optionalString(data.originalAppUserId)?.toLowerCase();
  if (!original || original !== deriveSuperwallAppUserId(uid)) {
    return { status: 'app_user_id_mismatch' };
  }
  return { status: 'ok', userId: uid };
}

export function resolveSuperwallUserId(
  data: SuperwallEventData | undefined,
): string | undefined {
  const identity = resolveSuperwallIdentity(data);
  return identity.status === 'ok' ? identity.userId : undefined;
}

/** Which identity fields an event carried. Shapes only — never values. */
export function describeSuperwallIdentity(
  data: SuperwallEventData | undefined,
): Record<string, string> {
  const attrs = parseUserAttributes(data?.userAttributes);
  const describe = (value: unknown) =>
    typeof value !== 'string' || !value.trim()
      ? 'absent'
      : value.trim().startsWith('$')
        ? 'superwall_alias'
        : isDeviceOrAnonymousAppUserId(value)
          ? 'uuid'
          : 'other';
  return {
    originalAppUserId: describe(data?.originalAppUserId),
    'userAttributes.firebaseUid': describe(attrs.firebaseUid),
    'userAttributes.firebase_uid': describe(attrs.firebase_uid),
    'userAttributes.appUserId': describe(attrs.appUserId),
    'userAttributes.aliasId': describe(attrs.aliasId),
  };
}

export type PurchaseTarget =
  | { status: 'unknown_user' }
  | { status: 'foreign_transaction'; ownerUserId: string }
  | { status: 'ok'; userId: string; bindTransaction: boolean };

/**
 * Decide which Firebase uid may receive this event.
 *
 * A receipt (`originalTransactionId`) is owned by the first account that
 * was bound to it — including a legacy device / alias binding, which is
 * never rebound onto a new uid. Later accounts on the same device do
 * not inherit that grant. The owner is never a fallback grant target:
 * an event without a verified uid grants nobody.
 */
export function resolvePurchaseTarget(options: {
  claimedUserId?: string;
  transactionOwnerUserId?: string;
  originalTransactionId?: string;
}): PurchaseTarget {
  const claimed = options.claimedUserId?.trim() || undefined;
  const owner = options.transactionOwnerUserId?.trim() || undefined;
  const transactionId = options.originalTransactionId?.trim() || undefined;

  if (!claimed) {
    return { status: 'unknown_user' };
  }

  if (owner && owner !== claimed) {
    return { status: 'foreign_transaction', ownerUserId: owner };
  }

  return {
    status: 'ok',
    userId: claimed,
    bindTransaction: Boolean(transactionId && !owner),
  };
}

export async function loadTransactionOwner(
  originalTransactionId: string,
): Promise<string | undefined> {
  const id = originalTransactionId.trim();
  if (!id) {
    return undefined;
  }
  const item = await getItem(
    keys.transactionOwnerPk(id),
    keys.transactionOwnerSk,
  );
  if (!item || item.entityType !== 'ENTITLEMENT_TXN') {
    return undefined;
  }
  const userId = typeof item.userId === 'string' ? item.userId.trim() : '';
  return userId || undefined;
}

/** First writer wins. Returns false when the receipt is already bound. */
export async function bindTransactionOwner(
  originalTransactionId: string,
  userId: string,
): Promise<boolean> {
  const id = originalTransactionId.trim();
  const owner = sanitizeAppUserId(userId);
  if (!id || !owner) {
    return false;
  }
  return putItemIfNotExists(transactionOwnerItem(id, owner));
}

function transactionOwnerItem(
  originalTransactionId: string,
  userId: string,
  timestamp = nowIso(),
): DynamoItem {
  return {
    PK: keys.transactionOwnerPk(originalTransactionId),
    SK: keys.transactionOwnerSk,
    entityType: 'ENTITLEMENT_TXN',
    userId,
    originalTransactionId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
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

const MS_PER_DAY = 86_400_000;
const DEFAULT_GRANT_DAYS = 30;
const YEARLY_GRANT_DAYS = 365;

/**
 * Latest row for GET /me and create gates. A FREE/NONE seed
 * (`SK=ENTITLEMENT`, no Superwall event) never beats a subscription
 * history row, even when the seed was written later.
 */
export function pickLatestEntitlement(
  rows: StoredEntitlement[],
): StoredEntitlement | undefined {
  if (rows.length === 0) {
    return undefined;
  }
  const history = rows.filter((row) => !isFreeSeedEntitlement(row));
  const pool = history.length > 0 ? history : rows;
  return pool.reduce((latest, row) =>
    compareEntitlementRecency(row, latest) >= 0 ? row : latest,
  );
}

export function isFreeSeedEntitlement(row: StoredEntitlement): boolean {
  return row.tier === 'FREE' && row.status === 'NONE' && !row.lastEventId;
}

function compareEntitlementRecency(
  a: StoredEntitlement,
  b: StoredEntitlement,
): number {
  const byUpdated = a.updatedAt.localeCompare(b.updatedAt);
  if (byUpdated !== 0) {
    return byUpdated;
  }
  const byCreated = a.createdAt.localeCompare(b.createdAt);
  if (byCreated !== 0) {
    return byCreated;
  }
  return (a.sk ?? '').localeCompare(b.sk ?? '');
}

function resolveEventExpiresAt(options: {
  expirationAtMs?: number;
  granting: boolean;
  expired: boolean;
  period?: EntitlementPeriod;
  inherited?: string;
  timestamp: string;
}): string | undefined {
  if (
    typeof options.expirationAtMs === 'number' &&
    Number.isFinite(options.expirationAtMs)
  ) {
    return new Date(options.expirationAtMs).toISOString();
  }
  if (options.expired) {
    return options.inherited ?? options.timestamp;
  }
  if (options.granting) {
    // Do not inherit a past expiresAt — that demotes a fresh paid grant.
    return defaultGrantExpiresAt(options.period, options.timestamp);
  }
  return options.inherited;
}

export function defaultGrantExpiresAt(
  period: EntitlementPeriod | undefined,
  fromIso: string,
): string {
  const start = Date.parse(fromIso);
  const base = Number.isFinite(start) ? start : Date.now();
  const days = period === 'YEARLY' ? YEARLY_GRANT_DAYS : DEFAULT_GRANT_DAYS;
  return new Date(base + days * MS_PER_DAY).toISOString();
}

function historySkUnique(stored: StoredEntitlement): string {
  const fromEvent = sanitizeSkPart(stored.lastEventId);
  if (fromEvent) {
    return fromEvent;
  }
  return `row_${nanoid(10)}`;
}

function sanitizeSkPart(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return cleaned || undefined;
}

export function effectiveEntitlement(
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
    sk: typeof item.SK === 'string' ? item.SK : undefined,
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

/**
 * Superwall / StoreKit device and anonymous identities. Never grant
 * `USER#{id}` Premium for these — they are not Firebase uids.
 *
 * - Any `$`-prefixed Superwall id (`$SuperwallAlias:`, `$SuperwallAnonymous:`, …)
 * - Raw iOS IDFV / Superwall alias UUID, dashed, braced or as 32 hex
 *   (StoreKit `appAccountToken` must be a UUID — Firebase uids are not)
 */
export function isDeviceOrAnonymousAppUserId(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith('$')) {
    return true;
  }
  return DEVICE_OR_ALIAS_UUID.test(trimmed) || HEX_UUID.test(trimmed);
}

const DEVICE_OR_ALIAS_UUID =
  /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;
const HEX_UUID = /^[0-9a-f]{32}$/i;

function sanitizeAppUserId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || isDeviceOrAnonymousAppUserId(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function parseUserAttributes(value: unknown): Record<string, string> {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return {};
    }
    try {
      return asStringRecord(JSON.parse(trimmed) as unknown);
    } catch {
      return {};
    }
  }
  return asStringRecord(value);
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
