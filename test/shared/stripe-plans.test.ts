import { featuresForTier } from '../../src/shared/entitlements';
import { FREE_CATALOG_LIMITS } from '../../src/shared/types';
import {
  DEFAULT_STRIPE_LOOKUP_KEY_BASIC_MONTHLY,
  DEFAULT_STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY,
  resolveStripePlans,
} from '../../src/shared/stripe-plans';

describe('stripe plans (WARDROBE-187)', () => {
  it('exposes Basic and Premium monthly prices from config lookup keys', () => {
    const plans = resolveStripePlans({});
    expect(plans.map((plan) => plan.tier)).toEqual(['BASIC', 'PREMIUM']);
    expect(plans[0]?.monthly.lookupKey).toBe(DEFAULT_STRIPE_LOOKUP_KEY_BASIC_MONTHLY);
    expect(plans[1]?.monthly.lookupKey).toBe(
      DEFAULT_STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY,
    );
    expect(plans[0]?.monthly.priceId).toBeUndefined();
    expect(plans[1]?.monthly.priceId).toBeUndefined();
    expect(plans[0]?.monthly.unitAmount).toBe(500);
    expect(plans[1]?.monthly.unitAmount).toBe(1500);
    expect(plans[0]?.monthly.currency).toBe('gbp');
  });

  it('reuses entitlement features and does not duplicate Free catalog limits', () => {
    const plans = resolveStripePlans({});
    for (const plan of plans) {
      expect(plan.features).toEqual(featuresForTier(plan.tier));
      expect(plan.limits).toBeNull();
    }
    expect(plans[0]?.features.aiTryOn).toBe(false);
    expect(plans[1]?.features.aiTryOn).toBe(true);
    expect(plans[0]?.features.unlimitedCatalog).toBe(true);
    const source = JSON.stringify(plans);
    expect(source).not.toContain('wardrobes');
    expect(source).not.toContain(`"items":${FREE_CATALOG_LIMITS.items}`);
    expect(source).not.toMatch(/price_1[A-Za-z0-9]{8,}/);
  });

  it('reads lookup keys and optional price ids from env, not hard-coded live ids', () => {
    const plans = resolveStripePlans({
      STRIPE_LOOKUP_KEY_BASIC_MONTHLY: 'basic_monthly_test',
      STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY: 'premium_monthly_test',
      STRIPE_PRICE_ID_BASIC_MONTHLY: 'price_test_basic',
      STRIPE_CURRENCY: 'usd',
      STRIPE_UNIT_AMOUNT_PREMIUM_MONTHLY: '2000',
    });
    expect(plans[0]?.monthly.lookupKey).toBe('basic_monthly_test');
    expect(plans[1]?.monthly.lookupKey).toBe('premium_monthly_test');
    expect(plans[0]?.monthly.priceId).toBe('price_test_basic');
    expect(plans[1]?.monthly.priceId).toBeUndefined();
    expect(plans[1]?.monthly.unitAmount).toBe(2000);
    expect(plans[0]?.monthly.currency).toBe('usd');
  });
});
