import { Errors } from '../../src/shared/errors';
import {
  BILLING_PLANS_CACHE_TTL_MS,
  listPublicBillingPlans,
  resetBillingPlansCache,
  StripeCatalogClient,
  StripeCatalogPrice,
} from '../../src/shared/stripe-catalog';
import { StripeRuntimeConfig } from '../../src/shared/stripe-config';

const SECRET_KEY = 'sk_test_DO_NOT_LOG_THIS_VALUE_9f3a';

function stripeConfig(): StripeRuntimeConfig {
  return {
    mode: 'test',
    secretKey: SECRET_KEY,
    webhookSecret: 'whsec_unused',
    lookupKeys: {
      basicMonthly: 'wardrobe_basic_monthly',
      premiumMonthly: 'wardrobe_premium_monthly',
      basicYearly: 'wardrobe_basic_yearly',
      premiumYearly: 'wardrobe_premium_yearly',
    },
    priceIds: {},
  };
}

function catalogPrice(options: {
  lookupKey: string;
  unitAmount: number;
  currency?: string;
  productName?: string;
  active?: boolean;
  id?: string;
  productAsId?: boolean;
}): StripeCatalogPrice {
  return {
    active: options.active ?? true,
    lookup_key: options.lookupKey,
    unit_amount: options.unitAmount,
    currency: options.currency ?? 'GBP',
    product: options.productAsId
      ? 'prod_should_not_leak'
      : { name: options.productName ?? 'Wardrobe Plan' },
  };
}

function allPrices(): StripeCatalogPrice[] {
  return [
    catalogPrice({
      lookupKey: 'wardrobe_premium_yearly',
      unitAmount: 15000,
      productName: 'Wardrobe Premium',
      id: 'price_premium_yearly_secret',
    }),
    catalogPrice({
      lookupKey: 'wardrobe_basic_monthly',
      unitAmount: 500,
      productName: 'Wardrobe Basic',
      id: 'price_basic_monthly_secret',
    }),
    catalogPrice({
      lookupKey: 'wardrobe_premium_monthly',
      unitAmount: 1500,
      productName: 'Wardrobe Premium',
      id: 'price_premium_monthly_secret',
    }),
    catalogPrice({
      lookupKey: 'wardrobe_basic_yearly',
      unitAmount: 5000,
      productName: 'Wardrobe Basic',
      id: 'price_basic_yearly_secret',
    }),
  ];
}

function mockStripe(data: StripeCatalogPrice[]): StripeCatalogClient & {
  pricesList: jest.Mock;
} {
  const pricesList = jest.fn().mockResolvedValue({ data });
  return {
    prices: { list: pricesList },
    pricesList,
  };
}

describe('listPublicBillingPlans (WARDROBE-207)', () => {
  beforeEach(() => {
    resetBillingPlansCache();
  });

  afterEach(() => {
    resetBillingPlansCache();
  });

  it('returns the four catalog plans in basic/premium monthly/yearly order', async () => {
    const stripe = mockStripe(allPrices());
    const plans = await listPublicBillingPlans({
      getStripeConfig: async () => stripeConfig(),
      getStripeClient: async () => stripe,
    });

    expect(plans).toEqual([
      {
        tier: 'basic',
        interval: 'monthly',
        lookupKey: 'wardrobe_basic_monthly',
        unitAmount: 500,
        currency: 'gbp',
        productName: 'Wardrobe Basic',
      },
      {
        tier: 'basic',
        interval: 'yearly',
        lookupKey: 'wardrobe_basic_yearly',
        unitAmount: 5000,
        currency: 'gbp',
        productName: 'Wardrobe Basic',
      },
      {
        tier: 'premium',
        interval: 'monthly',
        lookupKey: 'wardrobe_premium_monthly',
        unitAmount: 1500,
        currency: 'gbp',
        productName: 'Wardrobe Premium',
      },
      {
        tier: 'premium',
        interval: 'yearly',
        lookupKey: 'wardrobe_premium_yearly',
        unitAmount: 15000,
        currency: 'gbp',
        productName: 'Wardrobe Premium',
      },
    ]);
    expect(JSON.stringify(plans)).not.toMatch(/price_/);
    expect(JSON.stringify(plans)).not.toContain('sk_test_');
    expect(JSON.stringify(plans)).not.toContain('prod_');
    expect(stripe.pricesList).toHaveBeenCalledWith({
      lookup_keys: [
        'wardrobe_basic_monthly',
        'wardrobe_basic_yearly',
        'wardrobe_premium_monthly',
        'wardrobe_premium_yearly',
      ],
      active: true,
      expand: ['data.product'],
      limit: 4,
    });
  });

  it('returns PLANS_UNAVAILABLE when a lookup key is missing', async () => {
    const stripe = mockStripe(allPrices().slice(1));
    await expect(
      listPublicBillingPlans({
        getStripeConfig: async () => stripeConfig(),
        getStripeClient: async () => stripe,
      }),
    ).rejects.toMatchObject({
      code: 'PLANS_UNAVAILABLE',
      statusCode: 503,
      message: Errors.plansUnavailable().message,
    });
    expect(stripe.pricesList).toHaveBeenCalledTimes(1);
  });

  it('returns PLANS_UNAVAILABLE when a matching price is inactive', async () => {
    const prices = allPrices();
    prices[0] = catalogPrice({
      lookupKey: 'wardrobe_premium_yearly',
      unitAmount: 15000,
      productName: 'Wardrobe Premium',
      active: false,
    });
    const stripe = mockStripe(prices);
    await expect(
      listPublicBillingPlans({
        getStripeConfig: async () => stripeConfig(),
        getStripeClient: async () => stripe,
      }),
    ).rejects.toMatchObject({
      code: 'PLANS_UNAVAILABLE',
      statusCode: 503,
    });
  });

  it('returns PLANS_UNAVAILABLE when Stripe is unconfigured', async () => {
    const stripe = mockStripe(allPrices());
    await expect(
      listPublicBillingPlans({
        getStripeConfig: async () => {
          throw new Error('STRIPE_SECRET_ARN is not set.');
        },
        getStripeClient: async () => stripe,
      }),
    ).rejects.toMatchObject({
      code: 'PLANS_UNAVAILABLE',
      statusCode: 503,
    });
    expect(stripe.pricesList).not.toHaveBeenCalled();
  });

  it('returns PLANS_UNAVAILABLE when the Stripe secret is a placeholder', async () => {
    const stripe = mockStripe(allPrices());
    await expect(
      listPublicBillingPlans({
        getStripeConfig: async () => {
          throw new Error(
            'Stripe secretKey is a placeholder; replace the Secrets Manager value.',
          );
        },
        getStripeClient: async () => stripe,
      }),
    ).rejects.toMatchObject({
      code: 'PLANS_UNAVAILABLE',
      statusCode: 503,
    });
    expect(stripe.pricesList).not.toHaveBeenCalled();
  });

  it('does not expose Stripe internals when a product is not expanded', async () => {
    const prices = allPrices();
    prices[1] = catalogPrice({
      lookupKey: 'wardrobe_basic_monthly',
      unitAmount: 500,
      productAsId: true,
    });
    const stripe = mockStripe(prices);
    await expect(
      listPublicBillingPlans({
        getStripeConfig: async () => stripeConfig(),
        getStripeClient: async () => stripe,
      }),
    ).rejects.toMatchObject({ code: 'PLANS_UNAVAILABLE' });
  });

  it('reuses a successful catalog for the in-memory TTL without a second Stripe call', async () => {
    const stripe = mockStripe(allPrices());
    let now = 1_000;
    const deps = {
      getStripeConfig: async () => stripeConfig(),
      getStripeClient: async () => stripe,
      nowMs: () => now,
    };

    const first = await listPublicBillingPlans(deps);
    now += BILLING_PLANS_CACHE_TTL_MS - 1;
    const second = await listPublicBillingPlans(deps);

    expect(second).toEqual(first);
    expect(stripe.pricesList).toHaveBeenCalledTimes(1);
  });

  it('does not cache failures and calls Stripe again on the next attempt', async () => {
    const pricesList = jest
      .fn()
      .mockResolvedValueOnce({ data: allPrices().slice(0, 3) })
      .mockResolvedValueOnce({ data: allPrices() });
    const stripe: StripeCatalogClient & { pricesList: jest.Mock } = {
      prices: { list: pricesList },
      pricesList,
    };

    await expect(
      listPublicBillingPlans({
        getStripeConfig: async () => stripeConfig(),
        getStripeClient: async () => stripe,
      }),
    ).rejects.toMatchObject({ code: 'PLANS_UNAVAILABLE' });

    const plans = await listPublicBillingPlans({
      getStripeConfig: async () => stripeConfig(),
      getStripeClient: async () => stripe,
    });
    expect(plans).toHaveLength(4);
    expect(pricesList).toHaveBeenCalledTimes(2);
  });
});
