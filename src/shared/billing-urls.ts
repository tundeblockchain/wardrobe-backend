/**
 * Server-built Stripe Checkout return URLs (WARDROBE-189).
 *
 * Never read success/cancel URLs from the request body or headers.
 * The web origin comes from CDK context / env `billingWebOrigin`
 * (`BILLING_WEB_ORIGIN` at runtime).
 */
export const DEFAULT_BILLING_WEB_ORIGIN = 'https://wende-wardrobe.netlify.app';

/** Literal Stripe placeholder — must appear in success_url unchanged. */
export const CHECKOUT_SESSION_ID_PLACEHOLDER = '{CHECKOUT_SESSION_ID}';

export const BILLING_WEB_ORIGIN_ENV = 'BILLING_WEB_ORIGIN';

export function normalizeBillingWebOrigin(value: unknown): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim().replace(/\/+$/, '');
  }
  return DEFAULT_BILLING_WEB_ORIGIN;
}

export function resolveBillingWebOrigin(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return normalizeBillingWebOrigin(env[BILLING_WEB_ORIGIN_ENV]);
}

export function checkoutSuccessUrl(origin: string): string {
  const base = normalizeBillingWebOrigin(origin);
  return `${base}/app/billing/success?session_id=${CHECKOUT_SESSION_ID_PLACEHOLDER}`;
}

export function checkoutCancelUrl(origin: string): string {
  const base = normalizeBillingWebOrigin(origin);
  return `${base}/app/billing/cancel`;
}

export function checkoutReturnUrls(origin?: string): {
  successUrl: string;
  cancelUrl: string;
} {
  const resolved = normalizeBillingWebOrigin(origin);
  return {
    successUrl: checkoutSuccessUrl(resolved),
    cancelUrl: checkoutCancelUrl(resolved),
  };
}
