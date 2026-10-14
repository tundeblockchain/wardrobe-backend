import { seedStripePlans, StripeSeedClient } from '../../src/shared/stripe-seed';

function fakeClient(options?: {
  existingPrices?: Record<string, { id: string; product: string }>;
  existingProducts?: Array<{ id: string; tier: string }>;
}): StripeSeedClient & {
  createdPrices: unknown[];
  createdProducts: unknown[];
} {
  const createdPrices: unknown[] = [];
  const createdProducts: unknown[] = [];
  const prices = { ...(options?.existingPrices ?? {}) };
  const products = [...(options?.existingProducts ?? [])];
  let priceSeq = 0;
  let productSeq = 0;

  return {
    createdPrices,
    createdProducts,
    prices: {
      list: async ({ lookup_keys }) => {
        const key = lookup_keys[0];
        const found = key ? prices[key] : undefined;
        return {
          data: found
            ? [{ id: found.id, lookup_key: key, product: found.product }]
            : [],
        };
      },
      create: async (params) => {
        createdPrices.push(params);
        priceSeq += 1;
        const created = {
          id: `price_new_${priceSeq}`,
          lookup_key: params.lookup_key,
          product: params.product,
        };
        prices[params.lookup_key] = { id: created.id, product: params.product };
        return created;
      },
    },
    products: {
      list: async () => ({
        data: products.map((product) => ({
          id: product.id,
          name: product.tier,
          metadata: { wardrobe_tier: product.tier },
        })),
      }),
      create: async (params) => {
        createdProducts.push(params);
        productSeq += 1;
        const created = {
          id: `prod_new_${productSeq}`,
          name: params.name,
          metadata: params.metadata,
        };
        products.push({
          id: created.id,
          tier: params.metadata.wardrobe_tier,
        });
        return created;
      },
    },
  };
}

describe('seedStripePlans (WARDROBE-187)', () => {
  it('creates products and monthly prices when lookup keys are missing', async () => {
    const client = fakeClient();
    const results = await seedStripePlans(client, {});

    expect(results).toEqual([
      {
        tier: 'BASIC',
        lookupKey: 'wardrobe_basic_monthly',
        productId: 'prod_new_1',
        priceId: 'price_new_1',
        created: true,
      },
      {
        tier: 'PREMIUM',
        lookupKey: 'wardrobe_premium_monthly',
        productId: 'prod_new_2',
        priceId: 'price_new_2',
        created: true,
      },
    ]);
    expect(client.createdPrices).toHaveLength(2);
    expect(client.createdPrices[0]).toEqual(
      expect.objectContaining({
        lookup_key: 'wardrobe_basic_monthly',
        unit_amount: 500,
        currency: 'gbp',
        recurring: { interval: 'month' },
      }),
    );
  });

  it('is idempotent: existing lookup keys are reused and no prices are created', async () => {
    const client = fakeClient({
      existingPrices: {
        wardrobe_basic_monthly: { id: 'price_basic_existing', product: 'prod_b' },
        wardrobe_premium_monthly: {
          id: 'price_premium_existing',
          product: 'prod_p',
        },
      },
    });

    const results = await seedStripePlans(client, {});
    expect(results.map((row) => row.priceId)).toEqual([
      'price_basic_existing',
      'price_premium_existing',
    ]);
    expect(results.every((row) => row.created === false)).toBe(true);
    expect(client.createdPrices).toEqual([]);
    expect(client.createdProducts).toEqual([]);
  });

  it('reuses a product found by wardrobe_tier metadata', async () => {
    const client = fakeClient({
      existingProducts: [{ id: 'prod_basic_existing', tier: 'BASIC' }],
    });

    const results = await seedStripePlans(client, {});
    expect(results[0]?.productId).toBe('prod_basic_existing');
    expect(client.createdProducts).toHaveLength(1);
    expect(client.createdProducts[0]).toEqual(
      expect.objectContaining({ name: 'Wardrobe Premium' }),
    );
  });

  it('uses configured lookup keys and does not emit secret values', async () => {
    const client = fakeClient();
    const results = await seedStripePlans(client, {
      STRIPE_LOOKUP_KEY_BASIC_MONTHLY: 'cfg_basic_month',
      STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY: 'cfg_premium_month',
      STRIPE_SECRET_KEY: 'sk_test_should_not_appear',
    });

    const serialized = JSON.stringify({ results, created: client.createdPrices });
    expect(results.map((row) => row.lookupKey)).toEqual([
      'cfg_basic_month',
      'cfg_premium_month',
    ]);
    expect(serialized).not.toContain('sk_test_should_not_appear');
    expect(serialized).not.toMatch(/price_1[A-Za-z0-9]{20,}/);
  });
});
