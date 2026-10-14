import { portalReturnUrl, resolveBillingWebOrigin } from './billing-urls';
import { Errors } from './errors';
import { logger } from './logger';
import { PaidTierFields, toPaidTierStatus } from './paid-tier';
import { StripeMode } from './stripe-config';

export const STRIPE_PORTAL_CONFIGURATION_ID_ENV =
  'STRIPE_PORTAL_CONFIGURATION_ID';

export interface PortalSessionResult {
  url: string;
}

export interface StripePortalClient {
  billingPortal: {
    sessions: {
      create: (params: {
        customer: string;
        return_url: string;
        configuration?: string;
      }) => Promise<{ url?: string | null }>;
    };
  };
}

/**
 * Optional Stripe Billing Portal configuration id (CDK context
 * `stripePortalConfigurationId` / env `STRIPE_PORTAL_CONFIGURATION_ID`).
 * When set, the session uses that configuration so operators can allow
 * switching between the Basic and Premium prices.
 */
export function resolveStripePortalConfigurationId(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[STRIPE_PORTAL_CONFIGURATION_ID_ENV];
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return undefined;
}

/**
 * Portal is only for an active Stripe paid tier. Free / ios / android
 * (and paid rows with no stripe source) are 409 `NOT_STRIPE_PLAN`.
 */
export function assertStripePortalEligible(
  entitlement: PaidTierFields,
): void {
  const paid = toPaidTierStatus(entitlement);
  if (paid?.source !== 'stripe') {
    throw Errors.notStripePlan(paid?.source ?? null);
  }
}

export async function createBillingPortalSession(options: {
  customerId: string;
  stripe: StripePortalClient;
  origin?: string;
  configurationId?: string;
  mode?: StripeMode;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}): Promise<PortalSessionResult> {
  const origin = options.origin ?? resolveBillingWebOrigin();
  const returnUrl = portalReturnUrl(origin);
  const configurationId =
    options.configurationId ?? resolveStripePortalConfigurationId();

  const params: {
    customer: string;
    return_url: string;
    configuration?: string;
  } = {
    customer: options.customerId,
    return_url: returnUrl,
  };
  if (configurationId) {
    params.configuration = configurationId;
  }

  const session = await options.stripe.billingPortal.sessions.create(params);
  const url = session.url?.trim();
  if (!url) {
    throw Errors.internal('Stripe Billing Portal Session did not return a URL.');
  }

  const log = options.log ?? logger;
  // Mode and that a session was created — never the secret or URL internals.
  log.info('Stripe billing portal session created', {
    mode: options.mode,
    hasConfiguration: Boolean(configurationId),
  });

  return { url };
}
