import { StripePlanDefinition, resolveStripePlans } from './stripe-plans';

export interface StripeSeedPrice {
  id: string;
  lookup_key?: string | null;
  product: string | { id: string };
}

export interface StripeSeedProduct {
  id: string;
  name: string;
  metadata?: Record<string, string>;
}

export interface StripeSeedClient {
  prices: {
    list: (params: {
      lookup_keys: string[];
      limit?: number;
    }) => Promise<{ data: StripeSeedPrice[] }>;
    create: (params: {
      product: string;
      currency: string;
      unit_amount: number;
      recurring: { interval: 'month' };
      lookup_key: string;
      metadata: Record<string, string>;
    }) => Promise<StripeSeedPrice>;
  };
  products: {
    list: (params: { limit: number }) => Promise<{ data: StripeSeedProduct[] }>;
    create: (params: {
      name: string;
      metadata: Record<string, string>;
    }) => Promise<StripeSeedProduct>;
  };
}

export interface StripeSeedResult {
  tier: StripePlanDefinition['tier'];
  lookupKey: string;
  productId: string;
  priceId: string;
  created: boolean;
}

export async function seedStripePlans(
  client: StripeSeedClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StripeSeedResult[]> {
  const plans = resolveStripePlans(env);
  const results: StripeSeedResult[] = [];

  for (const plan of plans) {
    results.push(await seedPlan(client, plan));
  }
  return results;
}

async function seedPlan(
  client: StripeSeedClient,
  plan: StripePlanDefinition,
): Promise<StripeSeedResult> {
  const existing = await client.prices.list({
    lookup_keys: [plan.monthly.lookupKey],
    limit: 1,
  });
  const found = existing.data[0];
  if (found) {
    return {
      tier: plan.tier,
      lookupKey: plan.monthly.lookupKey,
      productId: productIdOf(found.product),
      priceId: found.id,
      created: false,
    };
  }

  const product = await findOrCreateProduct(client, plan);
  const price = await client.prices.create({
    product: product.id,
    currency: plan.monthly.currency,
    unit_amount: plan.monthly.unitAmount,
    recurring: { interval: 'month' },
    lookup_key: plan.monthly.lookupKey,
    metadata: {
      wardrobe_tier: plan.tier,
      wardrobe_period: 'MONTHLY',
    },
  });

  return {
    tier: plan.tier,
    lookupKey: plan.monthly.lookupKey,
    productId: product.id,
    priceId: price.id,
    created: true,
  };
}

async function findOrCreateProduct(
  client: StripeSeedClient,
  plan: StripePlanDefinition,
): Promise<StripeSeedProduct> {
  const listed = await client.products.list({ limit: 100 });
  const match = listed.data.find(
    (product) => product.metadata?.wardrobe_tier === plan.tier,
  );
  if (match) {
    return match;
  }
  return client.products.create({
    name: plan.productName,
    metadata: {
      wardrobe_tier: plan.tier,
    },
  });
}

function productIdOf(product: string | { id: string }): string {
  return typeof product === 'string' ? product : product.id;
}
