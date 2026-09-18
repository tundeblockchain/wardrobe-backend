import { getSecretString } from '../../shared/secrets';
import {
  parseSuperwallSecret,
  SuperwallSecretConfig,
} from '../../shared/superwall-config';
import { ProductTierMap } from '../../shared/entitlements';

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
 *     },
 *     "stripeSecretKey"?: "sk_…",
 *     "playPackageName"?: "your.android.package",
 *     "playServiceAccount"?: { "client_email", "private_key", "private_key_id"? }
 *   }
 *
 * Cancel fields are optional (WARDROBE-103) and ignored by this webhook.
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

export { parseSuperwallSecret };

async function readOptionalSecret(
  secretId: string | undefined,
): Promise<Pick<SuperwallSecretConfig, 'webhookSecret' | 'productTiers'>> {
  if (!secretId?.trim()) {
    return { productTiers: {} };
  }
  const parsed = parseSuperwallSecret(await getSecretString(secretId));
  return {
    webhookSecret: parsed.webhookSecret,
    productTiers: parsed.productTiers,
  };
}

function envString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}
