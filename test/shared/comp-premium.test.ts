const mockQueryByPk = jest.fn();
const mockPutItem = jest.fn();
const mockPutItemIfNotExists = jest.fn();
const mockGetItem = jest.fn();
const mockDeleteItem = jest.fn();
const mockScanByEntityType = jest.fn();
const mockUpdateAttributes = jest.fn();

jest.mock('../../src/shared/dynamodb', () => {
  const actual = jest.requireActual('../../src/shared/dynamodb') as typeof import('../../src/shared/dynamodb');
  return {
    ...actual,
    queryByPk: (...args: unknown[]) => mockQueryByPk(...args),
    putItem: (...args: unknown[]) => mockPutItem(...args),
    putItemIfNotExists: (...args: unknown[]) => mockPutItemIfNotExists(...args),
    getItem: (...args: unknown[]) => mockGetItem(...args),
    deleteItem: (...args: unknown[]) => mockDeleteItem(...args),
    scanByEntityType: (...args: unknown[]) => mockScanByEntityType(...args),
    updateAttributes: (...args: unknown[]) => mockUpdateAttributes(...args),
  };
});

import {
  applySuperwallEvent,
  clearStripePaidTier,
  effectiveEntitlement,
  ensureFreeEntitlement,
  grantCompPremium,
  persistEntitlement,
  pickLatestEntitlement,
  resolveEntitlement,
  revokeCompPremium,
  selectEffectiveEntitlement,
  setPaidTierStatus,
  StoredEntitlement,
  toEntitlementDto,
} from '../../src/shared/entitlements';
import { keys } from '../../src/shared/dynamodb';
import { paidTierBackfillPatch } from '../../src/shared/paid-tier-backfill';
import { DynamoItem } from '../../src/shared/types';

const UID = 'firebase-uid-reviewer';
const NOW_MS = Date.parse('2026-11-25T12:00:00.000Z');
const NOW_ISO = '2026-11-25T12:00:00.000Z';

function storeRow(overrides: Partial<DynamoItem> = {}): DynamoItem {
  return {
    PK: `USER#${UID}`,
    SK: 'ENTITLEMENT#2026-10-01T00:00:00.000Z#evt_store',
    entityType: 'ENTITLEMENT',
    userId: UID,
    tier: 'PREMIUM',
    status: 'EXPIRED',
    store: 'STRIPE',
    source: 'stripe',
    productId: 'wardrobe_premium_monthly',
    expiresAt: '2026-10-15T00:00:00.000Z',
    lastEventId: 'evt_store',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

function compRow(overrides: Partial<DynamoItem> = {}): DynamoItem {
  return {
    PK: `USER#${UID}`,
    SK: keys.entitlementCompSk,
    entityType: 'ENTITLEMENT',
    userId: UID,
    tier: 'PREMIUM',
    status: 'ACTIVE',
    store: 'COMP',
    source: 'comp',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function storedFrom(row: DynamoItem): StoredEntitlement {
  return {
    userId: String(row.userId),
    sk: String(row.SK),
    tier: (row.tier as StoredEntitlement['tier']) ?? 'FREE',
    status: (row.status as StoredEntitlement['status']) ?? 'NONE',
    store: row.store as StoredEntitlement['store'],
    source: row.source as StoredEntitlement['source'],
    productId: typeof row.productId === 'string' ? row.productId : undefined,
    expiresAt: typeof row.expiresAt === 'string' ? row.expiresAt : undefined,
    lastEventId: typeof row.lastEventId === 'string' ? row.lastEventId : undefined,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

describe('comp Premium resolution (WARDROBE-291)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryByPk.mockResolvedValue([]);
    mockPutItem.mockResolvedValue(undefined);
    mockPutItemIfNotExists.mockResolvedValue(true);
    mockGetItem.mockResolvedValue(undefined);
    mockDeleteItem.mockResolvedValue(undefined);
  });

  it('resolves PREMIUM from a COMP row even when the store row is lapsed', async () => {
    mockQueryByPk.mockResolvedValue([storeRow(), compRow()]);
    const resolved = await resolveEntitlement(UID, NOW_MS);
    expect(resolved).toEqual(
      expect.objectContaining({
        sk: keys.entitlementCompSk,
        tier: 'PREMIUM',
        status: 'ACTIVE',
        store: 'COMP',
        source: 'comp',
      }),
    );
    expect(resolved.expiresAt).toBeUndefined();
  });

  it('GET /me DTO exposes paidTier.source comp so clients can hide manage/upgrade', async () => {
    mockQueryByPk.mockResolvedValue([
      storeRow({
        store: 'APP_STORE',
        source: 'ios',
        status: 'EXPIRED',
        expiresAt: '2020-01-01T00:00:00.000Z',
      }),
      compRow(),
    ]);
    const resolved = await resolveEntitlement(UID, NOW_MS);
    const dto = toEntitlementDto(resolved, {
      wardrobes: 0,
      items: 0,
      outfits: 0,
    });
    expect(dto).toEqual(
      expect.objectContaining({
        tier: 'PREMIUM',
        status: 'ACTIVE',
        store: 'COMP',
        features: {
          unlimitedCatalog: true,
          aiTryOn: true,
          otherAi: true,
        },
        limits: null,
        paidTier: { tier: 'premium', source: 'comp' },
      }),
    );
    expect(dto).not.toHaveProperty('expiresAt');
    expect(dto).not.toHaveProperty('productId');
    expect(dto.paidTier).not.toHaveProperty('expiresAt');
  });

  it('falls back to the store row after the COMP row is gone', () => {
    const expiredStore = storedFrom(storeRow());
    expect(
      selectEffectiveEntitlement([expiredStore], NOW_MS, UID),
    ).toEqual(
      expect.objectContaining({
        tier: 'FREE',
        status: 'EXPIRED',
        source: 'stripe',
      }),
    );

    const activeStore = storedFrom(
      storeRow({
        status: 'ACTIVE',
        expiresAt: '2099-01-01T00:00:00.000Z',
        updatedAt: '2026-11-20T00:00:00.000Z',
      }),
    );
    expect(
      selectEffectiveEntitlement([activeStore], NOW_MS, UID),
    ).toEqual(
      expect.objectContaining({
        tier: 'PREMIUM',
        status: 'ACTIVE',
        source: 'stripe',
      }),
    );
  });

  it('does not let pickLatestEntitlement treat COMP as the store plan', () => {
    const latest = pickLatestEntitlement([
      storedFrom(compRow({ updatedAt: '2026-11-24T00:00:00.000Z' })),
      storedFrom(storeRow()),
    ]);
    expect(latest?.sk).toBe('ENTITLEMENT#2026-10-01T00:00:00.000Z#evt_store');
    expect(latest?.source).toBe('stripe');
  });

  it('never expires a COMP row at read time (lapse path)', () => {
    const withStaleExpiry = storedFrom(
      compRow({ expiresAt: '2020-01-01T00:00:00.000Z' }),
    );
    const effective = effectiveEntitlement(withStaleExpiry, NOW_MS);
    expect(effective.tier).toBe('PREMIUM');
    expect(effective.status).toBe('ACTIVE');
    expect(effective.source).toBe('comp');
    expect(effective.expiresAt).toBeUndefined();
  });

  it('ensureFreeEntitlement returns COMP without seeding over it', async () => {
    mockQueryByPk.mockResolvedValue([compRow()]);
    const stored = await ensureFreeEntitlement(UID, NOW_MS);
    expect(stored.tier).toBe('PREMIUM');
    expect(stored.source).toBe('comp');
    expect(mockPutItemIfNotExists).not.toHaveBeenCalled();
  });

  it('grantCompPremium writes the dedicated key and is idempotent', async () => {
    mockGetItem.mockResolvedValueOnce(undefined);
    const first = await grantCompPremium(UID, NOW_ISO);
    expect(first).toEqual({ applied: true, idempotent: false });
    expect(mockPutItem).toHaveBeenCalledWith(
      expect.objectContaining({
        PK: `USER#${UID}`,
        SK: keys.entitlementCompSk,
        entityType: 'ENTITLEMENT',
        tier: 'PREMIUM',
        status: 'ACTIVE',
        store: 'COMP',
        source: 'comp',
      }),
    );
    expect(mockPutItem.mock.calls[0][0].expiresAt).toBeUndefined();

    mockGetItem.mockResolvedValueOnce(compRow());
    mockPutItem.mockClear();
    const second = await grantCompPremium(UID, NOW_ISO);
    expect(second).toEqual({ applied: true, idempotent: true });
    expect(mockPutItem).not.toHaveBeenCalled();
  });

  it('revokeCompPremium deletes only the COMP key', async () => {
    await revokeCompPremium(UID);
    expect(mockDeleteItem).toHaveBeenCalledWith(
      `USER#${UID}`,
      keys.entitlementCompSk,
    );
  });

  it('store webhooks do not persist onto the COMP key', async () => {
    await persistEntitlement(storedFrom(compRow()));
    expect(mockPutItem).not.toHaveBeenCalled();

    mockQueryByPk.mockResolvedValue([compRow(), storeRow()]);
    await setPaidTierStatus({
      userId: UID,
      tier: 'premium',
      source: 'stripe',
      nowIso: NOW_ISO,
      nowMs: NOW_MS,
    });
    for (const call of mockPutItem.mock.calls) {
      expect(call[0].SK).not.toBe(keys.entitlementCompSk);
    }

    mockPutItem.mockClear();
    mockQueryByPk.mockResolvedValue([
      compRow(),
      storeRow({
        status: 'ACTIVE',
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
    ]);
    await clearStripePaidTier({ userId: UID, nowIso: NOW_ISO, nowMs: NOW_MS });
    for (const call of mockPutItem.mock.calls) {
      expect(call[0].SK).not.toBe(keys.entitlementCompSk);
      expect(call[0].source).not.toBe('comp');
    }
    expect(mockDeleteItem).not.toHaveBeenCalled();
  });

  it('Superwall expiration uses the store row, not COMP', () => {
    const result = applySuperwallEvent({
      existing: storedFrom(compRow()),
      history: [storedFrom(compRow()), storedFrom(storeRow())],
      userId: UID,
      eventName: 'expiration',
      productTiers: {},
      store: 'APP_STORE',
      eventId: 'evt_exp',
      nowIso: NOW_ISO,
    });
    expect(result.skipped).toBe(false);
    expect(result.stored.sk).toBeUndefined();
    expect(result.stored.source).not.toBe('comp');
    expect(result.stored.tier).toBe('FREE');
  });

  it('paid-tier backfill never patches the COMP row', () => {
    expect(paidTierBackfillPatch(compRow({ source: undefined }))).toBeNull();
  });
});
