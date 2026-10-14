import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import { resolveBillingWebOrigin } from '../../shared/billing-urls';
import { resolveEntitlement, StoredEntitlement } from '../../shared/entitlements';
import { Errors } from '../../shared/errors';
import { errorResponse, ok, parseJsonBody, parseOptionalJsonBody, routeKey } from '../../shared/http';
import { logger } from '../../shared/logger';
import { toPaidTierStatus } from '../../shared/paid-tier';
import {
  createSubscriptionCheckoutSession,
  parseCheckoutInterval,
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
  loadStripeCustomerId,
  StripeCustomerDeps,
} from '../../shared/stripe-customer';
import {
  assertStripePortalEligible,
  createBillingPortalSession,
  resolveStripePortalConfigurationId,
  StripePortalClient,
} from '../../shared/stripe-portal';

export interface BillingHandlerDeps {
  resolveEntitlement?: (userId: string) => Promise<StoredEntitlement>;
  ensureStripeCustomer?: (userId: string) => Promise<string>;
  loadStripeCustomerId?: (userId: string) => Promise<string | undefined>;
  getStripeConfig?: () => Promise<StripeRuntimeConfig>;
  getStripeClient?: () => Promise<StripeCheckoutClient>;
  getStripePortalClient?: () => Promise<StripePortalClient>;
  origin?: string;
  portalConfigurationId?: string;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
  stripeConfigDeps?: StripeConfigDeps;
  stripeCustomerDeps?: StripeCustomerDeps;
}

interface CheckoutSessionBody {
  tier?: unknown;
  interval?: unknown;
}

/**
 * Authenticated Stripe Checkout (WARDROBE-189 / WARDROBE-196) and
 * Billing Portal (WARDROBE-191).
 *
 * POST /billing/checkout-session
 *   { "tier": "basic" | "premium", "interval"?: "monthly" | "yearly" }
 * POST /billing/portal-session    (no body required)
 *
 * Checkout reuses one Stripe customer per Firebase uid and rejects
 * accounts that already have a paid tier from any source.
 * Portal is Stripe-only: current `paidTier.source` must be `stripe`
 * and `USER#{uid} / PROFILE.stripeCustomerId` must already be stored
 * (this handler never creates a customer).
 *
 * Return URLs are server-built from `BILLING_WEB_ORIGIN` — body and
 * header URL fields are ignored.
 *
 * The webhook is StripeWebhookFn (WARDROBE-190). DELETE /me Stripe
 * cancel is WARDROBE-192 on MeFn.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
  deps: BillingHandlerDeps = {},
): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = getUserId(event);
    const method = event.requestContext.http.method;
    const key = routeKey(event);

    if (method === 'POST' && isPortalRoute(key, event.rawPath)) {
      return ok(await createPortalSession(userId, event, deps));
    }

    if (method !== 'POST' || !isCheckoutRoute(key, event.rawPath)) {
      throw Errors.validation(`Unsupported route: ${key}`);
    }

    return ok(await createCheckoutSession(userId, event, deps));
  } catch (error) {
    return errorResponse(error);
  }
}

async function createCheckoutSession(
  userId: string,
  event: APIGatewayProxyEventV2,
  deps: BillingHandlerDeps,
): Promise<{ url: string }> {
  const body = parseJsonBody<CheckoutSessionBody>(event);
  const tier = parseCheckoutTier(body.tier);
  const interval = parseCheckoutInterval(body.interval);

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
  return createSubscriptionCheckoutSession({
    userId,
    tier,
    interval,
    customerId,
    stripe,
    config,
    origin,
    log,
  });
}

async function createPortalSession(
  userId: string,
  event: APIGatewayProxyEventV2,
  deps: BillingHandlerDeps,
): Promise<{ url: string }> {
  // Body is optional. Parse only so invalid JSON still 400s; URL fields
  // are ignored — return_url is always server-built.
  parseOptionalJsonBody<Record<string, unknown>>(event);

  const loadEntitlement = deps.resolveEntitlement ?? resolveEntitlement;
  const entitlement = await loadEntitlement(userId);
  assertStripePortalEligible(entitlement);

  const loadCustomerId = deps.loadStripeCustomerId ?? loadStripeCustomerId;
  const customerId = await loadCustomerId(userId);
  if (!customerId) {
    throw Errors.notStripePlan('stripe');
  }

  const log = deps.log ?? logger;
  const configDeps = deps.stripeConfigDeps ?? { log };
  const loadConfig = deps.getStripeConfig ?? (() => getStripeConfig(configDeps));
  const loadClient =
    deps.getStripePortalClient ??
    deps.getStripeClient ??
    (() => getStripeClient(configDeps) as Promise<StripePortalClient>);

  const [config, stripe] = await Promise.all([loadConfig(), loadClient()]);
  const origin = deps.origin ?? resolveBillingWebOrigin();
  const configurationId =
    deps.portalConfigurationId ?? resolveStripePortalConfigurationId();

  return createBillingPortalSession({
    customerId,
    stripe: stripe as StripePortalClient,
    origin,
    configurationId,
    mode: config.mode,
    log,
  });
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

function isPortalRoute(key: string, rawPath: string): boolean {
  return (
    key === 'POST /billing/portal-session' ||
    rawPath === '/billing/portal-session' ||
    rawPath.endsWith('/billing/portal-session')
  );
}
