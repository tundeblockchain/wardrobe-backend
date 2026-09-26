import {
  applySuperwallEvent,
  featuresForTier,
  mapProductToTier,
  parseProductTiers,
  resolveSuperwallUserId,
  superwallEventName,
  toEntitlementDto,
} from '../../src/shared/entitlements';
import { FREE_CATALOG_LIMITS } from '../../src/shared/types';

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

  it('resolves Flutter Firebase UID from originalAppUserId or userAttributes', () => {
    expect(
      resolveSuperwallUserId({ originalAppUserId: 'firebase-uid-owner' }),
    ).toBe('firebase-uid-owner');
    expect(
      resolveSuperwallUserId({
        originalAppUserId: '$SuperwallAlias:ABC',
        userAttributes: { firebaseUid: 'firebase-from-attrs' },
      }),
    ).toBe('firebase-from-attrs');
    expect(
      resolveSuperwallUserId({ originalAppUserId: '$SuperwallAlias:ABC' }),
    ).toBeUndefined();
  });

  it('overwrites a stored Free row when the user subscribes', () => {
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
    expect(subscribed.createdAt).toBe('2026-09-01T00:00:00.000Z');
    expect(subscribed.updatedAt).toBe('2026-09-16T00:00:00.000Z');
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
