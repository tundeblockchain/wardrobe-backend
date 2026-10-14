import {
  checkoutCancelUrl,
  checkoutSuccessUrl,
  resolveBillingWebOrigin,
} from './billing-urls';
import { Errors } from './errors';
import { logger } from './logger';
import { isPaidTier } from './paid-tier';
import { StripeRuntimeConfig } from './stripe-config';
import {
  CheckoutInterval,
  isCheckoutInterval,
  stripeLookupKeyForPaidTier,
  stripePriceIdForPaidTier,
} from './stripe-plans';
import { PaidTier } from './types';

export interface CheckoutSessionResult {
  url: string;
}

export interface StripeCheckoutClient {
  prices: {
    list: (params: {
      lookup_keys: string[];
      active: boolean;
      limit: number;
    }) => Promise<{ data: Array<{ id?: string }> }>;
  };
  checkout: {
    sessions: {
      create: (params: {
        mode: 'subscription';
        customer: string;
        client_reference_id: string;
        line_items: Array<{ price: string; quantity: number }>;
        success_url: string;
        cancel_url: string;
        subscription_data: { metadata: { uid: string; tier: string } };
      }) => Promise<{ url?: string | null }>;
    };
  };
}

export interface ResolveCheckoutPriceDeps {
  stripe: StripeCheckoutClient;
  config: StripeRuntimeConfig;
}

export function parseCheckoutTier(value: unknown): PaidTier {
  if (typeof value === 'string' && isPaidTier(value.trim())) {
    return value.trim() as PaidTier;
  }
  throw Errors.validation('tier must be "basic" or "premium".');
}

/**
 * Optional checkout `interval`. Missing / undefined defaults to monthly.
 * Any other value, including non-strings, is `INVALID_INTERVAL`.
 */
export function parseCheckoutInterval(value: unknown): CheckoutInterval {
  if (value === undefined) {
    return 'monthly';
  }
  if (typeof value === 'string' && isCheckoutInterval(value.trim())) {
    return value.trim() as CheckoutInterval;
  }
  throw Errors.invalidInterval();
}

export async function resolveCheckoutPriceId(
  tier: PaidTier,
  deps: ResolveCheckoutPriceDeps,
  interval: CheckoutInterval = 'monthly',
): Promise<{ priceId: string; lookupKey: string }> {
  const lookupKey = stripeLookupKeyForPaidTier(
    tier,
    deps.config.lookupKeys,
    interval,
  );
  const pinned = stripePriceIdForPaidTier(tier, deps.config.priceIds, interval);
  if (pinned) {
    return { priceId: pinned, lookupKey };
  }

  const listed = await deps.stripe.prices.list({
    lookup_keys: [lookupKey],
    active: true,
    limit: 1,
  });
  const priceId = listed.data[0]?.id?.trim();
  if (!priceId) {
    throw Errors.billingPriceNotFound();
  }
  return { priceId, lookupKey };
}

export async function createSubscriptionCheckoutSession(options: {
  userId: string;
  tier: PaidTier;
  interval?: CheckoutInterval;
  customerId: string;
  stripe: StripeCheckoutClient;
  config: StripeRuntimeConfig;
  origin?: string;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}): Promise<CheckoutSessionResult> {
  const interval = options.interval ?? 'monthly';
  const origin = options.origin ?? resolveBillingWebOrigin();
  const successUrl = checkoutSuccessUrl(origin);
  const cancelUrl = checkoutCancelUrl(origin);
  const { priceId, lookupKey } = await resolveCheckoutPriceId(
    options.tier,
    {
      stripe: options.stripe,
      config: options.config,
    },
    interval,
  );

  const session = await options.stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: options.customerId,
    client_reference_id: options.userId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    subscription_data: {
      metadata: { uid: options.userId, tier: options.tier },
    },
  });

  const url = session.url?.trim();
  if (!url) {
    throw Errors.internal('Stripe Checkout Session did not return a URL.');
  }

  const log = options.log ?? logger;
  // Mode and lookup key only — never the secret key or session internals.
  log.info('Stripe checkout session created', {
    tier: options.tier,
    interval,
    mode: options.config.mode,
    lookupKey,
  });

  return { url };
}
