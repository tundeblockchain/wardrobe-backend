const mockQueryByPk = jest.fn();
const mockPutItem = jest.fn();
const mockPutItemIfNotExists = jest.fn();
const mockGetItem = jest.fn();

jest.mock('../../src/shared/dynamodb', () => {
  const actual = jest.requireActual('../../src/shared/dynamodb') as typeof import('../../src/shared/dynamodb');
  return {
    ...actual,
    queryByPk: (...args: unknown[]) => mockQueryByPk(...args),
    putItem: (...args: unknown[]) => mockPutItem(...args),
    putItemIfNotExists: (...args: unknown[]) => mockPutItemIfNotExists(...args),
    getItem: (...args: unknown[]) => mockGetItem(...args),
  };
});

import {
  applySuperwallEvent,
  assertCanCreateCatalog,
  defaultGrantExpiresAt,
  ensureFreeEntitlement,
  featuresForTier,
  mapProductToTier,
  parseProductTiers,
  persistEntitlement,
  pickLatestEntitlement,
  resolveEntitlement,
  resolvePurchaseTarget,
  deriveSuperwallAppUserId,
  resolveSuperwallIdentity,
  resolveSuperwallUserId,
  isDeviceOrAnonymousAppUserId,
  StoredEntitlement,
  superwallEventName,
  toEntitlementDto,
  bindTransactionOwner,
  loadTransactionOwner,
} from '../../src/shared/entitlements';
import { DynamoItem, FREE_CATALOG_LIMITS } from '../../src/shared/types';

describe('entitlement mapping (WARDROBE-91)', () => {
  it('maps configured product IDs from the operator secret', () => {
    const productTiers = parseProductTiers({
      'com.wardrobe.basic.monthly': 'BASIC',
      'com.wardrobe.premium.yearly': 'PREMIUM',
      ignored: 'FREE',
    });

    expect(mapProductToTier('com.wardrobe.basic.monthly', productTiers)).toBe(
      'BASIC',
    );
    expect(mapProductToTier('com.wardrobe.premium.yearly', productTiers)).toBe(
      'PREMIUM',
    );
  });

  it('falls back to a premium/basic substring heuristic when IDs are TBD', () => {
    expect(mapProductToTier('sku_Premium_Month', {})).toBe('PREMIUM');
    expect(mapProductToTier('sku_basic_year', {})).toBe('BASIC');
  });

  it('defaults paid grants with an unknown product to BASIC', () => {
    expect(
      mapProductToTier('com.unknown.sku', {}, { paidGrant: true }),
    ).toBe('BASIC');
    expect(mapProductToTier('com.unknown.sku', {})).toBeUndefined();
  });

  const DEVICE_ID = '7152E89E-60A6-4B2E-9C67-D7ED8F5BE372';
  const ANON_ID = `$SuperwallAlias:${DEVICE_ID}`;
  const UID_A_APP_USER_ID = '87fd3c93-5175-41f0-9dda-2884927fbc28';

  it('derives the Superwall app user id from the Firebase uid (WARDROBE-167)', () => {
    expect(deriveSuperwallAppUserId('uid-a')).toBe(UID_A_APP_USER_ID);
    expect(deriveSuperwallAppUserId('uid-b')).not.toBe(UID_A_APP_USER_ID);
    expect(deriveSuperwallAppUserId('uid-b')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('grants userAttributes.firebaseUid only when its derived id is originalAppUserId', () => {
    for (const original of [UID_A_APP_USER_ID, UID_A_APP_USER_ID.toUpperCase()]) {
      expect(
        resolveSuperwallIdentity({
          originalAppUserId: original,
          userAttributes: { firebaseUid: 'uid-a' },
        }),
      ).toEqual({ status: 'ok', userId: 'uid-a' });
    }
    expect(
      resolveSuperwallUserId({
        originalAppUserId: UID_A_APP_USER_ID,
        userAttributes: JSON.stringify({ firebase_uid: 'uid-a' }),
      }),
    ).toBe('uid-a');
    expect(
      resolveSuperwallIdentity({
        originalAppUserId: UID_A_APP_USER_ID,
        userAttributes: { firebaseUid: 'uid-b' },
      }),
    ).toEqual({ status: 'app_user_id_mismatch' });
  });

  it('grants nobody for a device id, alias, raw uid or missing firebaseUid', () => {
    for (const original of [DEVICE_ID, DEVICE_ID.toLowerCase(), ANON_ID, 'uid-a', undefined]) {
      expect(
        resolveSuperwallIdentity({
          originalAppUserId: original,
          userAttributes: { firebaseUid: 'uid-a' },
        }),
      ).toEqual({ status: 'app_user_id_mismatch' });
    }
    expect(
      resolveSuperwallIdentity({
        originalAppUserId: UID_A_APP_USER_ID,
        appUserId: 'uid-a',
        userAttributes: { appUserId: 'uid-a', aliasId: ANON_ID },
      }),
    ).toEqual({ status: 'unknown_user' });
    expect(
      resolveSuperwallIdentity({
        originalAppUserId: UID_A_APP_USER_ID,
        userAttributes: { firebaseUid: 'uid-a', firebase_uid: 'uid-b' },
      }),
    ).toEqual({ status: 'ambiguous_user' });
    expect(isDeviceOrAnonymousAppUserId(DEVICE_ID)).toBe(true);
    expect(isDeviceOrAnonymousAppUserId(ANON_ID)).toBe(true);
    expect(isDeviceOrAnonymousAppUserId('firebase-uid-account-b')).toBe(false);
  });

  it('builds a new ACTIVE record when the user subscribes over Free', () => {
    const subscribed = applySuperwallEvent({
      existing: {
        userId: 'uid',
        tier: 'FREE',
        status: 'NONE',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
      userId: 'uid',
      eventName: 'initial_purchase',
      productId: 'premium_monthly',
      productTiers: {},
      eventId: 'evt_sub',
      nowIso: '2026-09-16T00:00:00.000Z',
    }).stored;

    expect(subscribed.tier).toBe('PREMIUM');
    expect(subscribed.status).toBe('ACTIVE');
    expect(subscribed.createdAt).toBe('2026-09-16T00:00:00.000Z');
    expect(subscribed.updatedAt).toBe('2026-09-16T00:00:00.000Z');
    expect(subscribed.expiresAt).toBe(
      defaultGrantExpiresAt('MONTHLY', '2026-09-16T00:00:00.000Z'),
    );
  });

  it('grants PREMIUM on initial_purchase and keeps access on cancellation until expiry', () => {
    const granted = applySuperwallEvent({
      userId: 'uid',
      eventName: 'initial_purchase',
      productId: 'premium_monthly',
      productTiers: {},
      expirationAtMs: Date.parse('2026-10-16T00:00:00.000Z'),
      eventId: 'evt_1',
      nowIso: '2026-09-16T00:00:00.000Z',
    }).stored;

    expect(granted.tier).toBe('PREMIUM');
    expect(granted.status).toBe('ACTIVE');
    expect(granted.period).toBe('MONTHLY');

    const canceled = applySuperwallEvent({
      existing: granted,
      userId: 'uid',
      eventName: 'cancellation',
      productTiers: {},
      eventId: 'evt_2',
      nowIso: '2026-09-17T00:00:00.000Z',
    }).stored;

    expect(canceled.tier).toBe('PREMIUM');
    expect(canceled.status).toBe('CANCELED');
  });

  it('revokes to FREE on expiration and skips duplicate event ids', () => {
    const existing = applySuperwallEvent({
      userId: 'uid',
      eventName: 'renewal',
      productId: 'basic_yearly',
      productTiers: {},
      eventId: 'evt_dup',
      nowIso: '2026-09-16T00:00:00.000Z',
    }).stored;

    const duplicate = applySuperwallEvent({
      existing,
      userId: 'uid',
      eventName: 'renewal',
      productId: 'basic_yearly',
      productTiers: {},
      eventId: 'evt_dup',
    });
    expect(duplicate.skipped).toBe(true);

    const expired = applySuperwallEvent({
      existing,
      userId: 'uid',
      eventName: 'expiration',
      productTiers: {},
      eventId: 'evt_exp',
      nowIso: '2026-09-18T00:00:00.000Z',
    }).stored;
    expect(expired.tier).toBe('FREE');
    expect(expired.status).toBe('EXPIRED');
  });

  it('builds the Flutter GET /me DTO with Free caps and Premium unlimited', () => {
    const usage = { wardrobes: 1, items: 3, outfits: 2 };
    const free = toEntitlementDto(
      {
        userId: 'uid',
        tier: 'FREE',
        status: 'NONE',
        createdAt: '2026-09-16T00:00:00.000Z',
        updatedAt: '2026-09-16T00:00:00.000Z',
      },
      usage,
    );
    expect(free.features).toEqual(featuresForTier('FREE'));
    expect(free.limits).toEqual(FREE_CATALOG_LIMITS);
    expect(free.usage).toEqual(usage);

    const premium = toEntitlementDto(
      {
        userId: 'uid',
        tier: 'PREMIUM',
        status: 'ACTIVE',
        productId: 'sku',
        createdAt: '2026-09-16T00:00:00.000Z',
        updatedAt: '2026-09-16T00:00:00.000Z',
      },
      usage,
    );
    expect(premium.features.aiTryOn).toBe(true);
    expect(premium.limits).toBeNull();
    expect(premium.productId).toBe('sku');
  });

  it('reads Superwall event name from data.name or type', () => {
    expect(superwallEventName({ data: { name: 'renewal' } })).toBe('renewal');
    expect(superwallEventName({ type: 'cancellation' })).toBe('cancellation');
  });
});

describe('entitlement history (WARDROBE-159)', () => {
  const nowMs = Date.parse('2026-10-02T12:00:00.000Z');

  beforeEach(() => {
    mockQueryByPk.mockReset();
    mockPutItem.mockReset();
    mockPutItemIfNotExists.mockReset();
    mockQueryByPk.mockResolvedValue([]);
    mockPutItem.mockResolvedValue(undefined);
    mockPutItemIfNotExists.mockResolvedValue(true);
  });

  function stored(overrides: Partial<StoredEntitlement> = {}): StoredEntitlement {
    return {
      userId: 'uid',
      tier: 'PREMIUM',
      status: 'ACTIVE',
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
      ...overrides,
    };
  }

  function row(overrides: Partial<DynamoItem> = {}): DynamoItem {
    return {
      PK: 'USER#uid',
      SK: 'ENTITLEMENT',
      entityType: 'ENTITLEMENT',
      userId: 'uid',
      tier: 'PREMIUM',
      status: 'ACTIVE',
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
      ...overrides,
    };
  }

  it('appends a history SK on grant persist instead of overwriting ENTITLEMENT', async () => {
    const granted = applySuperwallEvent({
      userId: 'uid',
      eventName: 'initial_purchase',
      productId: 'premium_monthly',
      productTiers: {},
      eventId: 'evt_grant',
      nowIso: '2026-10-02T00:00:00.000Z',
    }).stored;

    await persistEntitlement(granted);

    expect(mockPutItem).toHaveBeenCalledWith(
      expect.objectContaining({
        PK: 'USER#uid',
        SK: 'ENTITLEMENT#2026-10-02T00:00:00.000Z#evt_grant',
        entityType: 'ENTITLEMENT',
        tier: 'PREMIUM',
        status: 'ACTIVE',
      }),
    );
    expect(mockPutItem.mock.calls[0][0].SK).not.toBe('ENTITLEMENT');
  });

  it('resolves the latest ACTIVE paid row over an older expired one', async () => {
    mockQueryByPk.mockResolvedValue([
      row({
        SK: 'ENTITLEMENT#2026-08-01T00:00:00.000Z#evt_old',
        status: 'EXPIRED',
        expiresAt: '2026-09-01T00:00:00.000Z',
        lastEventId: 'evt_old',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      }),
      row({
        SK: 'ENTITLEMENT#2026-10-01T00:00:00.000Z#evt_new',
        status: 'ACTIVE',
        expiresAt: '2026-11-01T00:00:00.000Z',
        lastEventId: 'evt_new',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      }),
    ]);

    const resolved = await resolveEntitlement('uid', nowMs);

    expect(resolved.tier).toBe('PREMIUM');
    expect(resolved.status).toBe('ACTIVE');
    expect(resolved.expiresAt).toBe('2026-11-01T00:00:00.000Z');
    expect(resolved.sk).toBe('ENTITLEMENT#2026-10-01T00:00:00.000Z#evt_new');
  });

  it('ignores a stale expiresAt on an older row when a newer paid row is current', () => {
    const latest = pickLatestEntitlement([
      stored({
        sk: 'ENTITLEMENT#old',
        status: 'CANCELED',
        expiresAt: '2020-01-01T00:00:00.000Z',
        lastEventId: 'evt_old',
        updatedAt: '2026-08-01T00:00:00.000Z',
      }),
      stored({
        sk: 'ENTITLEMENT#new',
        status: 'ACTIVE',
        expiresAt: '2026-11-01T00:00:00.000Z',
        lastEventId: 'evt_new',
        updatedAt: '2026-10-01T00:00:00.000Z',
      }),
    ]);

    expect(latest?.sk).toBe('ENTITLEMENT#new');
    expect(latest?.expiresAt).toBe('2026-11-01T00:00:00.000Z');
    expect(latest?.status).toBe('ACTIVE');
  });

  it('does not inherit a past expiresAt on a grant that omits expirationAt', () => {
    const granted = applySuperwallEvent({
      existing: stored({
        status: 'CANCELED',
        expiresAt: '2020-01-01T00:00:00.000Z',
        lastEventId: 'evt_old',
      }),
      userId: 'uid',
      eventName: 'initial_purchase',
      productId: 'premium_yearly',
      productTiers: {},
      eventId: 'evt_resub',
      nowIso: '2026-10-02T00:00:00.000Z',
    }).stored;

    expect(granted.tier).toBe('PREMIUM');
    expect(granted.status).toBe('ACTIVE');
    expect(granted.expiresAt).toBe(
      defaultGrantExpiresAt('YEARLY', '2026-10-02T00:00:00.000Z'),
    );
    expect(granted.expiresAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(Date.parse(granted.expiresAt!)).toBeGreaterThan(
      Date.parse('2026-10-02T00:00:00.000Z'),
    );
  });

  it('skips a duplicate event id already present in history', () => {
    const prior = stored({ lastEventId: 'evt_dup', sk: 'ENTITLEMENT#prior' });
    const latest = stored({
      lastEventId: 'evt_later',
      lastEventAt: 2_000,
      updatedAt: '2026-10-01T00:00:00.000Z',
      sk: 'ENTITLEMENT#later',
    });

    const duplicate = applySuperwallEvent({
      existing: latest,
      history: [prior, latest],
      userId: 'uid',
      eventName: 'renewal',
      productId: 'premium_monthly',
      productTiers: {},
      eventId: 'evt_dup',
    });

    expect(duplicate.skipped).toBe(true);
    expect(duplicate.stored.sk).toBe('ENTITLEMENT#prior');
  });

  it('skips an out-of-order event against the latest row', () => {
    const latest = stored({ lastEventId: 'evt_new', lastEventAt: 2_000 });
    const result = applySuperwallEvent({
      existing: latest,
      userId: 'uid',
      eventName: 'renewal',
      productTiers: {},
      eventId: 'evt_old',
      eventAtMs: 1_000,
    });

    expect(result.skipped).toBe(true);
    expect(result.stored.lastEventId).toBe('evt_new');
  });

  it('seeds Free with a conditional SK=ENTITLEMENT write', async () => {
    mockQueryByPk.mockResolvedValue([]);
    mockPutItemIfNotExists.mockResolvedValue(true);

    const seeded = await ensureFreeEntitlement('uid', nowMs);

    expect(seeded.tier).toBe('FREE');
    expect(seeded.status).toBe('NONE');
    expect(mockPutItemIfNotExists).toHaveBeenCalledWith(
      expect.objectContaining({
        PK: 'USER#uid',
        SK: 'ENTITLEMENT',
        tier: 'FREE',
        status: 'NONE',
      }),
    );
  });

  it('does not let a later Free seed beat a subscription that raced first', async () => {
    mockQueryByPk
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        row({
          SK: 'ENTITLEMENT',
          tier: 'FREE',
          status: 'NONE',
          createdAt: '2026-10-02T12:00:01.000Z',
          updatedAt: '2026-10-02T12:00:01.000Z',
        }),
        row({
          SK: 'ENTITLEMENT#2026-10-02T11:59:00.000Z#evt_sub',
          lastEventId: 'evt_sub',
          expiresAt: '2026-11-02T00:00:00.000Z',
          createdAt: '2026-10-02T11:59:00.000Z',
          updatedAt: '2026-10-02T11:59:00.000Z',
        }),
      ]);
    mockPutItemIfNotExists.mockResolvedValue(true);

    const resolved = await ensureFreeEntitlement('uid', nowMs);

    expect(resolved.tier).toBe('PREMIUM');
    expect(resolved.status).toBe('ACTIVE');
    expect(resolved.expiresAt).toBe('2026-11-02T00:00:00.000Z');
  });

  it('lets catalog creates through when the latest row is paid', async () => {
    mockQueryByPk.mockResolvedValue([
      row({
        SK: 'ENTITLEMENT#2026-08-01T00:00:00.000Z#evt_old',
        status: 'EXPIRED',
        expiresAt: '2026-09-01T00:00:00.000Z',
        lastEventId: 'evt_old',
        updatedAt: '2026-09-01T00:00:00.000Z',
      }),
      row({
        SK: 'ENTITLEMENT#2026-10-01T00:00:00.000Z#evt_new',
        lastEventId: 'evt_new',
        expiresAt: '2099-11-01T00:00:00.000Z',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      }),
    ]);

    await expect(assertCanCreateCatalog('uid', 'wardrobe')).resolves.toEqual(
      expect.objectContaining({ tier: 'PREMIUM', status: 'ACTIVE' }),
    );
    expect(mockQueryByPk).toHaveBeenCalledWith('USER#uid', 'ENTITLEMENT');
    expect(mockQueryByPk).toHaveBeenCalledTimes(1);
  });
});

describe('purchase identity (WARDROBE-165)', () => {
  const accountA = 'firebase-uid-account-a';
  const accountB = 'firebase-uid-account-b';
  const txnA = 'txn_account_a';
  const txnB = 'txn_account_b';

  beforeEach(() => {
    mockGetItem.mockReset();
    mockPutItemIfNotExists.mockReset();
    mockQueryByPk.mockReset();
    mockGetItem.mockResolvedValue(undefined);
    mockPutItemIfNotExists.mockResolvedValue(true);
    mockQueryByPk.mockResolvedValue([]);
  });

  it('attributes a new purchase to B after A already subscribed', () => {
    expect(
      resolvePurchaseTarget({
        claimedUserId: accountB,
        transactionOwnerUserId: undefined,
        originalTransactionId: txnB,
      }),
    ).toEqual({
      status: 'ok',
      userId: accountB,
      bindTransaction: true,
    });

    const grantedB = applySuperwallEvent({
      userId: accountB,
      eventName: 'initial_purchase',
      productId: 'premium_monthly',
      productTiers: {},
      originalTransactionId: txnB,
      eventId: 'evt_b',
      nowIso: '2026-10-04T00:00:00.000Z',
    }).stored;

    expect(grantedB.userId).toBe(accountB);
    expect(grantedB.tier).toBe('PREMIUM');
    expect(grantedB.status).toBe('ACTIVE');
    expect(grantedB.originalTransactionId).toBe(txnB);
  });

  it('does not let B inherit A\'s receipt', () => {
    expect(
      resolvePurchaseTarget({
        claimedUserId: accountB,
        transactionOwnerUserId: accountA,
        originalTransactionId: txnA,
      }),
    ).toEqual({
      status: 'foreign_transaction',
      ownerUserId: accountA,
    });
  });

  it('does not grant Premium on cancel or billing failure', () => {
    const canceled = applySuperwallEvent({
      userId: accountB,
      eventName: 'cancellation',
      productId: 'premium_monthly',
      productTiers: {},
      originalTransactionId: txnB,
      eventId: 'evt_cancel',
      nowIso: '2026-10-04T00:00:00.000Z',
    }).stored;
    expect(canceled.userId).toBe(accountB);
    expect(canceled.tier).toBe('FREE');
    expect(canceled.status).toBe('CANCELED');

    const failed = applySuperwallEvent({
      userId: accountB,
      eventName: 'billing_issue',
      productId: 'premium_monthly',
      productTiers: {},
      eventId: 'evt_fail',
      nowIso: '2026-10-04T00:00:00.000Z',
    }).stored;
    expect(failed.tier).toBe('FREE');
    expect(failed.status).toBe('BILLING_ISSUE');
  });

  it('resolves GET /me Premium for B only after B\'s own grant', async () => {
    const nowMs = Date.parse('2026-10-04T12:00:00.000Z');
    mockQueryByPk.mockImplementation(async (pk: string) => {
      if (pk === `USER#${accountA}`) {
        return [
          {
            PK: `USER#${accountA}`,
            SK: 'ENTITLEMENT#2026-10-01T00:00:00.000Z#evt_a',
            entityType: 'ENTITLEMENT',
            userId: accountA,
            tier: 'PREMIUM',
            status: 'ACTIVE',
            originalTransactionId: txnA,
            lastEventId: 'evt_a',
            expiresAt: '2026-11-01T00:00:00.000Z',
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        ];
      }
      if (pk === `USER#${accountB}`) {
        return [
          {
            PK: `USER#${accountB}`,
            SK: 'ENTITLEMENT#2026-10-04T00:00:00.000Z#evt_b',
            entityType: 'ENTITLEMENT',
            userId: accountB,
            tier: 'PREMIUM',
            status: 'ACTIVE',
            originalTransactionId: txnB,
            lastEventId: 'evt_b',
            expiresAt: '2026-11-04T00:00:00.000Z',
            createdAt: '2026-10-04T00:00:00.000Z',
            updatedAt: '2026-10-04T00:00:00.000Z',
          },
        ];
      }
      return [];
    });

    await expect(resolveEntitlement(accountA, nowMs)).resolves.toEqual(
      expect.objectContaining({
        userId: accountA,
        tier: 'PREMIUM',
        originalTransactionId: txnA,
      }),
    );
    await expect(resolveEntitlement(accountB, nowMs)).resolves.toEqual(
      expect.objectContaining({
        userId: accountB,
        tier: 'PREMIUM',
        originalTransactionId: txnB,
      }),
    );
  });

  it('keeps B Free when only A has a grant on the device', async () => {
    const nowMs = Date.parse('2026-10-04T12:00:00.000Z');
    mockQueryByPk.mockImplementation(async (pk: string) => {
      if (pk === `USER#${accountA}`) {
        return [
          {
            PK: `USER#${accountA}`,
            SK: 'ENTITLEMENT#2026-10-01T00:00:00.000Z#evt_a',
            entityType: 'ENTITLEMENT',
            userId: accountA,
            tier: 'PREMIUM',
            status: 'ACTIVE',
            originalTransactionId: txnA,
            lastEventId: 'evt_a',
            expiresAt: '2026-11-01T00:00:00.000Z',
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        ];
      }
      return [];
    });

    await expect(resolveEntitlement(accountB, nowMs)).resolves.toEqual(
      expect.objectContaining({ userId: accountB, tier: 'FREE', status: 'NONE' }),
    );
  });

  it('binds a new receipt to the granting Firebase uid', async () => {
    mockPutItemIfNotExists.mockResolvedValue(true);
    await expect(bindTransactionOwner(txnB, accountB)).resolves.toBe(true);
    expect(mockPutItemIfNotExists).toHaveBeenCalledWith(
      expect.objectContaining({
        PK: `TXN#${txnB}`,
        SK: 'OWNER',
        entityType: 'ENTITLEMENT_TXN',
        userId: accountB,
        originalTransactionId: txnB,
      }),
    );

    mockGetItem.mockResolvedValue({
      PK: `TXN#${txnA}`,
      SK: 'OWNER',
      entityType: 'ENTITLEMENT_TXN',
      userId: accountA,
      originalTransactionId: txnA,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    await expect(loadTransactionOwner(txnA)).resolves.toBe(accountA);
  });

  const legacyDeviceId = '7152E89E-60A6-4B2E-9C67-D7ED8F5BE372';

  it('never grants the receipt owner when the event has no verified uid (WARDROBE-167)', () => {
    expect(
      resolvePurchaseTarget({
        claimedUserId: undefined,
        transactionOwnerUserId: accountA,
        originalTransactionId: txnA,
      }),
    ).toEqual({ status: 'unknown_user' });
  });

  it('keeps a legacy device-alias receipt owner; a new uid is not rebound onto it', async () => {
    mockGetItem.mockResolvedValue({
      PK: `TXN#${txnA}`,
      SK: 'OWNER',
      entityType: 'ENTITLEMENT_TXN',
      userId: legacyDeviceId,
      originalTransactionId: txnA,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    await expect(loadTransactionOwner(txnA)).resolves.toBe(legacyDeviceId);
    expect(
      resolvePurchaseTarget({
        claimedUserId: accountB,
        transactionOwnerUserId: legacyDeviceId,
        originalTransactionId: txnA,
      }),
    ).toEqual({ status: 'foreign_transaction', ownerUserId: legacyDeviceId });

    mockPutItemIfNotExists.mockReset();
    mockPutItemIfNotExists.mockResolvedValue(false);
    mockPutItem.mockClear();
    await expect(bindTransactionOwner(txnA, accountB)).resolves.toBe(false);
    expect(mockPutItemIfNotExists).toHaveBeenCalledTimes(1);
    expect(mockPutItem).not.toHaveBeenCalled();
  });

  it('never binds a receipt to a device or alias id', async () => {
    mockPutItemIfNotExists.mockClear();
    await expect(bindTransactionOwner(txnB, legacyDeviceId)).resolves.toBe(false);
    await expect(
      bindTransactionOwner(txnB, `$SuperwallAlias:${legacyDeviceId}`),
    ).resolves.toBe(false);
    expect(mockPutItemIfNotExists).not.toHaveBeenCalled();
  });
});
