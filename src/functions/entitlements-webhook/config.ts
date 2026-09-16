import { getSecretString, parseJsonObjectOrString } from '../../shared/secrets';
import { parseProductTiers, ProductTierMap } from '../../shared/entitlements';

/**
 * Superwall webhook config (WARDROBE-91).
 *
 * Production Lambdas receive SUPERWALL_SECRET_ARN only. Tests may set
 * SUPERWALL_WEBHOOK_SECRET. Never commit the real signing secret or
 * live App Store / Play product IDs.
 *
 * Secret JSON shape (placeholder until operators fill it):
 *   {
 *     "webhookSecret": "whsec_…",
 *     "productTiers": {
 *       "<app-store-or-play-product-id>": "BASIC" | "PREMIUM"
 *     }
 *   }
 */
export interface SuperwallConfig {
  webhookSecret: string;
  productTiers: ProductTierMap;
}

export async function loadSuperwallConfig(): Promise<SuperwallConfig> {
  const fromSecret = await readOptionalSecret(process.env.SUPERWALL_SECRET_ARN);
  const webhookSecret =
    envString('SUPERWALL_WEBHOOK_SECRET') ?? fromSecret.webhookSecret;
  if (!webhookSecret) {
    throw new Error('SUPERWALL_WEBHOOK_SECRET is not configured');
  }

  return {
    webhookSecret,
    productTiers: fromSecret.productTiers,
  };
}

export function parseSuperwallSecret(
  secretString: string,
): Partial<SuperwallConfig> {
  const parsed = parseJsonObjectOrString(secretString);
  if (typeof parsed === 'string') {
    return { webhookSecret: parsed, productTiers: {} };
  }

  const webhookSecret = firstString(parsed, [
    'webhookSecret',
    'webhook_secret',
    'signingSecret',
    'SUPERWALL_WEBHOOK_SECRET',
  ]);

  return {
    webhookSecret,
    productTiers: parseProductTiers(
      parsed.productTiers ?? parsed.product_tiers ?? parsed.products,
    ),
  };
}

async function readOptionalSecret(
  secretId: string | undefined,
): Promise<{ webhookSecret?: string; productTiers: ProductTierMap }> {
  if (!secretId?.trim()) {
    return { productTiers: {} };
  }
  const parsed = parseSuperwallSecret(await getSecretString(secretId));
  return {
    webhookSecret: parsed.webhookSecret,
    productTiers: parsed.productTiers ?? {},
  };
}

function envString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function firstString(
  record: Record<string, unknown>,
  keysToTry: string[],
): string | undefined {
  for (const key of keysToTry) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
