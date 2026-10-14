/**
 * Idempotent Stripe Product + monthly Price seed (WARDROBE-187).
 *
 * Creates or finds Basic and Premium products and monthly prices using
 * lookup_keys from config (never hard-coded live price ids). Safe to re-run
 * against whichever Stripe secret key is supplied.
 *
 *   STRIPE_SECRET_KEY=sk_test_... npm run stripe:seed
 *
 * Optional env (defaults match the existing product matrix):
 *   STRIPE_LOOKUP_KEY_BASIC_MONTHLY=wardrobe_basic_monthly
 *   STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY=wardrobe_premium_monthly
 *   STRIPE_UNIT_AMOUNT_BASIC_MONTHLY=500
 *   STRIPE_UNIT_AMOUNT_PREMIUM_MONTHLY=1500
 *   STRIPE_CURRENCY=gbp
 *
 * Prints product and price ids. Does not print the secret key.
 */

import Stripe from 'stripe';
import { seedStripePlans } from '../src/shared/stripe-seed';

function resolveSecretKey(): string {
  const key =
    process.env.STRIPE_SECRET_KEY?.trim() || process.env.STRIPE_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'Set STRIPE_SECRET_KEY (or STRIPE_API_KEY) to a Stripe test or live secret key.',
    );
  }
  return key;
}

async function main(): Promise<void> {
  const secretKey = resolveSecretKey();
  const client = new Stripe(secretKey);
  const results = await seedStripePlans(client);

  process.stdout.write(
    `${JSON.stringify(
      {
        plans: results.map((row) => ({
          tier: row.tier,
          lookupKey: row.lookupKey,
          productId: row.productId,
          priceId: row.priceId,
          created: row.created,
        })),
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`stripe:seed failed: ${message}\n`);
  process.exitCode = 1;
});
