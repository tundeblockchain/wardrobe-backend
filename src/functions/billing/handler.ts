import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import { resolveBillingWebOrigin } from '../../shared/billing-urls';
import { resolveEntitlement, StoredEntitlement } from '../../shared/entitlements';
import { Errors } from '../../shared/errors';
import { errorResponse, ok, parseJsonBody, routeKey } from '../../shared/http';
import { logger } from '../../shared/logger';
import { toPaidTierStatus } from '../../shared/paid-tier';
import {
  createSubscriptionCheckoutSession,
  parseCheckoutTier,
  StripeCheckoutClient,
} from '../../shared/stripe-checkout';
import {
  getStripeClient,
  getStripeConfig,
  StripeConfigDeps,
  StripeRuntimeConfig,
} from '../../shared/stripe-config';
import {
  ensureStripeCustomer,
  StripeCustomerDeps,
} from '../../shared/stripe-customer';

export interface BillingHandlerDeps {
  resolveEntitlement?: (userId: string) => Promise<StoredEntitlement>;
  ensureStripeCustomer?: (userId: string) => Promise<string>;
  getStripeConfig?: () => Promise<StripeRuntimeConfig>;
  getStripeClient?: () => Promise<StripeCheckoutClient>;
  origin?: string;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
  stripeConfigDeps?: StripeConfigDeps;
  stripeCustomerDeps?: StripeCustomerDeps;
}

interface CheckoutSessionBody {
  tier?: unknown;
}

/**
 * Authenticated Stripe Checkout (WARDROBE-189).
 *
 * POST /billing/checkout-session  { "tier": "basic" | "premium" }
 *
 * Reuses one Stripe customer per Firebase uid. Rejects accounts that
 * already have a paid tier from any source (ios / android / stripe).
 * Return URLs are server-built from `BILLING_WEB_ORIGIN` — body and
 * header URL fields are ignored.
 *
 * Does not implement the webhook, portal, or DELETE /me cancel (190–192).
 */
export async function handler(
  event: APIGatewayProxyEventV2,
  deps: BillingHandlerDeps = {},
): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = getUserId(event);
    const method = event.requestContext.http.method;
    const key = routeKey(event);

    if (method !== 'POST' || !isCheckoutRoute(key, event.rawPath)) {
      throw Errors.validation(`Unsupported route: ${key}`);
    }

    const body = parseJsonBody<CheckoutSessionBody>(event);
    const tier = parseCheckoutTier(body.tier);

    const loadEntitlement = deps.resolveEntitlement ?? resolveEntitlement;
    const entitlement = await loadEntitlement(userId);
    assertNotAlreadySubscribed(entitlement);

    const log = deps.log ?? logger;
    const configDeps = deps.stripeConfigDeps ?? { log };
    const loadConfig = deps.getStripeConfig ?? (() => getStripeConfig(configDeps));
    const loadClient =
      deps.getStripeClient ??
      (() => getStripeClient(configDeps) as Promise<StripeCheckoutClient>);

    const resolveCustomer =
      deps.ensureStripeCustomer ??
      ((uid: string) =>
        ensureStripeCustomer(uid, {
          ...deps.stripeCustomerDeps,
          getStripeClient:
            deps.stripeCustomerDeps?.getStripeClient ??
            (() => getStripeClient(configDeps)),
          log,
        }));

    const [config, customerId, stripe] = await Promise.all([
      loadConfig(),
      resolveCustomer(userId),
      loadClient(),
    ]);

    const origin = deps.origin ?? resolveBillingWebOrigin();
    const session = await createSubscriptionCheckoutSession({
      userId,
      tier,
      customerId,
      stripe,
      config,
      origin,
      log,
    });

    return ok(session);
  } catch (error) {
    return errorResponse(error);
  }
}

export function assertNotAlreadySubscribed(
  entitlement: StoredEntitlement,
): void {
  const paid = toPaidTierStatus(entitlement);
  if (!paid) {
    return;
  }
  throw Errors.alreadySubscribed(paid.source);
}

function isCheckoutRoute(key: string, rawPath: string): boolean {
  return (
    key === 'POST /billing/checkout-session' ||
    rawPath === '/billing/checkout-session' ||
    rawPath.endsWith('/billing/checkout-session')
  );
}
