const mockQueryByPk = jest.fn();
const mockPutItem = jest.fn();
const mockPutItemIfNotExists = jest.fn();
const mockGetItem = jest.fn();
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
    scanByEntityType: (...args: unknown[]) => mockScanByEntityType(...args),
    updateAttributes: (...args: unknown[]) => mockUpdateAttributes(...args),
  };
});

import { logger } from '../../src/shared/logger';
import {
  decidePaidTierWrite,
  hydratePaidTierFields,
  paidTierSourceFromStore,
  toPaidTierStatus,
} from '../../src/shared/paid-tier';
import {
  backfillPaidTierRecords,
  paidTierBackfillPatch,
  paidTierBackfillRows,
} from '../../src/shared/paid-tier-backfill';
import {
  featuresForTier,
  clearStripePaidTier,
  setPaidTierStatus,
  toEntitlementDto,
} from '../../src/shared/entitlements';
import { DynamoItem, FREE_CATALOG_LIMITS } from '../../src/shared/types';

describe('paid-tier mapping (WARDROBE-188)', () => {
  it('derives source from the existing store attribute', () => {
    expect(paidTierSourceFromStore('APP_STORE')).toBe('ios');
    expect(paidTierSourceFromStore('PLAY_STORE')).toBe('android');
    expect(paidTierSourceFromStore('STRIPE')).toBe('stripe');
    expect(paidTierSourceFromStore('UNKNOWN')).toBeUndefined();
    expect(paidTierSourceFromStore(undefined)).toBeUndefined();
  });

  it('hydrates source on read without inventing one for UNKNOWN', () => {
    expect(
      hydratePaidTierFields({
        tier: 'PREMIUM' as const,
        store: 'APP_STORE' as const,
      }).source,
    ).toBe('ios');
    expect(
      hydratePaidTierFields({
        tier: 'BASIC' as const,
        store: 'PLAY_STORE' as const,
        source: 'android' as const,
      }).source,
    ).toBe('android');
    expect(
      hydratePaidTierFields({
        tier: 'PREMIUM' as const,
        store: 'UNKNOWN' as const,
      }).source,
    ).toBeUndefined();
  });

  it('builds paidTier for Basic and Premium and null for Free', () => {
    expect(
      toPaidTierStatus({
        tier: 'FREE',
        status: 'NONE',
      }),
    ).toBeNull();
    expect(
      toPaidTierStatus({
        tier: 'BASIC',
        store: 'PLAY_STORE',
        expiresAt: '2026-11-01T00:00:00.000Z',
      }),
    ).toEqual({
      tier: 'basic',
      source: 'android',
      expiresAt: '2026-11-01T00:00:00.000Z',
    });
    expect(
      toPaidTierStatus({
        tier: 'PREMIUM',
        store: 'APP_STORE',
      }),
    ).toEqual({
      tier: 'premium',
      source: 'ios',
    });
  });
});

describe('paid-tier write clash rule (WARDROBE-188)', () => {
  const nowMs = Date.parse('2026-10-14T12:00:00.000Z');

  it('allows a same-source Basic → Premium upgrade', () => {
    expect(
      decidePaidTierWrite({
        existing: {
          tier: 'BASIC',
          status: 'ACTIVE',
          store: 'APP_STORE',
          expiresAt: '2026-11-01T00:00:00.000Z',
        },
        incoming: { tier: 'premium', source: 'ios' },
        nowMs,
      }),
    ).toEqual({ action: 'apply', reason: 'upgraded' });
  });

  it('allows a same-source renew', () => {
    expect(
      decidePaidTierWrite({
        existing: {
          tier: 'PREMIUM',
          status: 'ACTIVE',
          source: 'ios',
          expiresAt: '2026-11-01T00:00:00.000Z',
        },
        incoming: { tier: 'premium', source: 'ios' },
        nowMs,
      }),
    ).toEqual({ action: 'apply', reason: 'renewed' });
  });

  it('keeps an active plan when a different source arrives', () => {
    expect(
      decidePaidTierWrite({
        existing: {
          tier: 'PREMIUM',
          status: 'ACTIVE',
          store: 'APP_STORE',
          expiresAt: '2026-11-01T00:00:00.000Z',
        },
        incoming: { tier: 'premium', source: 'stripe' },
        nowMs,
      }),
    ).toEqual({ action: 'clash', reason: 'source_clash' });
  });

  it('lets any source replace an expired plan', () => {
    expect(
      decidePaidTierWrite({
        existing: {
          tier: 'PREMIUM',
          status: 'ACTIVE',
          store: 'APP_STORE',
          expiresAt: '2026-09-01T00:00:00.000Z',
        },
        incoming: { tier: 'basic', source: 'stripe' },
        nowMs,
      }),
    ).toEqual({ action: 'apply', reason: 'replaced_expired' });
  });

  it('creates when the account is Free', () => {
    expect(
      decidePaidTierWrite({
        existing: { tier: 'FREE', status: 'NONE' },
        incoming: { tier: 'premium', source: 'stripe' },
        nowMs,
      }),
    ).toEqual({ action: 'apply', reason: 'created' });
  });
});

describe('setPaidTierStatus (WARDROBE-188)', () => {
  const nowIso = '2026-10-14T12:00:00.000Z';
  const nowMs = Date.parse(nowIso);

  beforeEach(() => {
    mockQueryByPk.mockReset();
    mockPutItem.mockReset();
    mockQueryByPk.mockResolvedValue([]);
    mockPutItem.mockResolvedValue(undefined);
  });

  function row(overrides: Partial<DynamoItem> = {}): DynamoItem {
    return {
      PK: 'USER#uid',
      SK: 'ENTITLEMENT#2026-10-01T00:00:00.000Z#evt_ios',
      entityType: 'ENTITLEMENT',
      userId: 'uid',
      tier: 'BASIC',
      status: 'ACTIVE',
      store: 'APP_STORE',
      expiresAt: '2026-11-01T00:00:00.000Z',
      lastEventId: 'evt_ios',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('persists a same-source upgrade', async () => {
    mockQueryByPk.mockResolvedValue([row()]);

    const result = await setPaidTierStatus({
      userId: 'uid',
      tier: 'premium',
      source: 'ios',
      expiresAt: '2026-12-01T00:00:00.000Z',
      nowIso,
      nowMs,
    });

    expect(result).toEqual(
      expect.objectContaining({
        applied: true,
        reason: 'upgraded',
        stored: expect.objectContaining({
          tier: 'PREMIUM',
          source: 'ios',
          store: 'APP_STORE',
          status: 'ACTIVE',
          expiresAt: '2026-12-01T00:00:00.000Z',
        }),
      }),
    );
    expect(mockPutItem).toHaveBeenCalledWith(
      expect.objectContaining({
        SK: expect.stringMatching(/^ENTITLEMENT#/),
        tier: 'PREMIUM',
        source: 'ios',
        store: 'APP_STORE',
      }),
    );
  });

  it('keeps the active plan and logs on a different-source clash', async () => {
    mockQueryByPk.mockResolvedValue([row()]);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const result = await setPaidTierStatus({
      userId: 'uid',
      tier: 'premium',
      source: 'stripe',
      expiresAt: '2026-12-01T00:00:00.000Z',
      nowIso,
      nowMs,
    });

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('source_clash');
    expect(result.stored.tier).toBe('BASIC');
    expect(result.stored.source).toBe('ios');
    expect(mockPutItem).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'Paid-tier source clash; keeping active plan',
      expect.objectContaining({
        existingSource: 'ios',
        incomingSource: 'stripe',
        existingTier: 'BASIC',
        incomingTier: 'premium',
      }),
    );
    warn.mockRestore();
  });

  it('replaces an expired plan from a different source', async () => {
    mockQueryByPk.mockResolvedValue([
      row({
        tier: 'PREMIUM',
        expiresAt: '2026-09-01T00:00:00.000Z',
      }),
    ]);

    const result = await setPaidTierStatus({
      userId: 'uid',
      tier: 'basic',
      source: 'stripe',
      expiresAt: '2026-11-14T00:00:00.000Z',
      nowIso,
      nowMs,
    });

    expect(result).toEqual(
      expect.objectContaining({
        applied: true,
        reason: 'replaced_expired',
        stored: expect.objectContaining({
          tier: 'BASIC',
          source: 'stripe',
          store: 'STRIPE',
          expiresAt: '2026-11-14T00:00:00.000Z',
        }),
      }),
    );
    expect(mockPutItem).toHaveBeenCalledTimes(1);
  });
});

describe('clearStripePaidTier (WARDROBE-190)', () => {
  const nowIso = '2026-10-14T12:00:00.000Z';
  const nowMs = Date.parse(nowIso);

  beforeEach(() => {
    mockQueryByPk.mockReset();
    mockPutItem.mockReset();
    mockQueryByPk.mockResolvedValue([]);
    mockPutItem.mockResolvedValue(undefined);
  });

  it('clears an active Stripe paid tier', async () => {
    mockQueryByPk.mockResolvedValue([
      {
        PK: 'USER#uid',
        SK: 'ENTITLEMENT#2026-10-01T00:00:00.000Z#evt_stripe',
        entityType: 'ENTITLEMENT',
        userId: 'uid',
        tier: 'PREMIUM',
        status: 'ACTIVE',
        store: 'STRIPE',
        source: 'stripe',
        expiresAt: '2026-11-01T00:00:00.000Z',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
    ]);

    const result = await clearStripePaidTier({
      userId: 'uid',
      lastEventId: 'evt_cancel',
      nowIso,
      nowMs,
    });

    expect(result).toEqual(
      expect.objectContaining({
        cleared: true,
        reason: 'cleared',
        stored: expect.objectContaining({
          tier: 'FREE',
          status: 'EXPIRED',
          source: 'stripe',
        }),
      }),
    );
    expect(mockPutItem).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 'FREE',
        status: 'EXPIRED',
        source: 'stripe',
        lastEventId: 'evt_cancel',
      }),
    );
  });

  it('does not clear an active ios plan', async () => {
    mockQueryByPk.mockResolvedValue([
      {
        PK: 'USER#uid',
        SK: 'ENTITLEMENT#2026-10-01T00:00:00.000Z#evt_ios',
        entityType: 'ENTITLEMENT',
        userId: 'uid',
        tier: 'BASIC',
        status: 'ACTIVE',
        store: 'APP_STORE',
        source: 'ios',
        expiresAt: '2026-11-01T00:00:00.000Z',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
    ]);

    const result = await clearStripePaidTier({
      userId: 'uid',
      nowIso,
      nowMs,
    });

    expect(result).toEqual(
      expect.objectContaining({ cleared: false, reason: 'not_stripe' }),
    );
    expect(mockPutItem).not.toHaveBeenCalled();
  });
});

describe('GET /me paidTier DTO and plan limits (WARDROBE-188)', () => {
  const usage = { wardrobes: 1, items: 2, outfits: 1 };

  it('keeps catalog limits on the existing limits mapping', () => {
    const free = toEntitlementDto(
      {
        userId: 'uid',
        tier: 'FREE',
        status: 'NONE',
        createdAt: now(),
        updatedAt: now(),
      },
      usage,
    );
    expect(free.limits).toEqual(FREE_CATALOG_LIMITS);
    expect(free.features).toEqual(featuresForTier('FREE'));
    expect(free.paidTier).toBeNull();
    expect(free.tier).toBe('FREE');

    const basic = toEntitlementDto(
      {
        userId: 'uid',
        tier: 'BASIC',
        status: 'ACTIVE',
        store: 'PLAY_STORE',
        createdAt: now(),
        updatedAt: now(),
      },
      usage,
    );
    expect(basic.limits).toBeNull();
    expect(basic.features.unlimitedCatalog).toBe(true);
    expect(basic.features.aiTryOn).toBe(false);
    expect(basic.paidTier).toEqual({ tier: 'basic', source: 'android' });
    expect(basic.tier).toBe('BASIC');
    expect(basic.store).toBe('PLAY_STORE');

    const premium = toEntitlementDto(
      {
        userId: 'uid',
        tier: 'PREMIUM',
        status: 'ACTIVE',
        store: 'STRIPE',
        expiresAt: '2026-11-01T00:00:00.000Z',
        createdAt: now(),
        updatedAt: now(),
      },
      usage,
    );
    expect(premium.limits).toBeNull();
    expect(premium.features.aiTryOn).toBe(true);
    expect(premium.paidTier).toEqual({
      tier: 'premium',
      source: 'stripe',
      expiresAt: '2026-11-01T00:00:00.000Z',
    });
    expect(premium.tier).toBe('PREMIUM');
  });

  function now() {
    return '2026-10-14T00:00:00.000Z';
  }
});

describe('paid-tier backfill (WARDROBE-188)', () => {
  it('fills source from store and tier from productId when missing', () => {
    expect(
      paidTierBackfillPatch({
        PK: 'USER#uid',
        SK: 'ENTITLEMENT',
        entityType: 'ENTITLEMENT',
        userId: 'uid',
        store: 'APP_STORE',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toEqual({ source: 'ios' });

    expect(
      paidTierBackfillPatch({
        PK: 'USER#uid',
        SK: 'ENTITLEMENT#1',
        entityType: 'ENTITLEMENT',
        userId: 'uid',
        productId: 'premium_monthly',
        store: 'PLAY_STORE',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toEqual({ source: 'android', tier: 'PREMIUM' });
  });

  it('is a no-op when source and tier are already filled', () => {
    expect(
      paidTierBackfillPatch({
        PK: 'USER#uid',
        SK: 'ENTITLEMENT',
        entityType: 'ENTITLEMENT',
        userId: 'uid',
        tier: 'PREMIUM',
        source: 'ios',
        store: 'APP_STORE',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('scans and updates only rows that need a patch', async () => {
    mockScanByEntityType.mockReset();
    mockUpdateAttributes.mockReset();
    mockScanByEntityType.mockResolvedValue([
      {
        PK: 'USER#a',
        SK: 'ENTITLEMENT',
        entityType: 'ENTITLEMENT',
        userId: 'a',
        tier: 'BASIC',
        store: 'APP_STORE',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        PK: 'USER#b',
        SK: 'ENTITLEMENT',
        entityType: 'ENTITLEMENT',
        userId: 'b',
        tier: 'PREMIUM',
        source: 'stripe',
        store: 'STRIPE',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    mockUpdateAttributes.mockResolvedValue({});

    const dry = await backfillPaidTierRecords({ apply: false });
    expect(dry).toEqual({
      scanned: 2,
      updated: 1,
      skipped: 1,
      dryRun: true,
    });
    expect(mockUpdateAttributes).not.toHaveBeenCalled();

    const applied = await backfillPaidTierRecords({ apply: true });
    expect(applied).toEqual({
      scanned: 2,
      updated: 1,
      skipped: 1,
      dryRun: false,
    });
    expect(mockUpdateAttributes).toHaveBeenCalledTimes(1);
    expect(mockUpdateAttributes).toHaveBeenCalledWith('USER#a', 'ENTITLEMENT', {
      source: 'ios',
    });
  });

  it('ignores non-entitlement rows', () => {
    expect(
      paidTierBackfillRows([
        {
          PK: 'USER#a',
          SK: 'PROFILE',
          entityType: 'PROFILE',
          userId: 'a',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    ).toEqual([]);
  });
});
