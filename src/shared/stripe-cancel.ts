import Stripe from 'stripe';
import { AppError, Errors } from './errors';
import { logger } from './logger';
import { getSecretString } from './secrets';
import {
  getStripeClient,
  getStripeConfig,
  isStripeUnconfiguredError,
  StripeConfigDeps,
} from './stripe-config';
import { loadStripeCustomerId } from './stripe-customer';
import {
  looksLikePlaceholderCredential,
  parseSuperwallSecret,
} from './superwall-config';

/** Subscriptions that still bill — cancel these on account delete. */
export const CANCELABLE_STRIPE_SUBSCRIPTION_STATUSES = [
  'active',
  'trialing',
  'past_due',
] as const;

export type CancelableStripeSubscriptionStatus =
  (typeof CANCELABLE_STRIPE_SUBSCRIPTION_STATUSES)[number];

export const STRIPE_SUBSCRIPTION_CANCEL_IDEMPOTENCY_PREFIX =
  'account-delete-cancel-';

export function stripeSubscriptionCancelIdempotencyKey(
  subscriptionId: string,
): string {
  return `${STRIPE_SUBSCRIPTION_CANCEL_IDEMPOTENCY_PREFIX}${subscriptionId}`;
}

export interface StripeSubscriptionListPage {
  data: Array<{ id?: string; status?: string }>;
  has_more?: boolean;
}

export interface StripeCancelClient {
  subscriptions: {
    list: (params: {
      customer: string;
      status: CancelableStripeSubscriptionStatus;
      limit: number;
      starting_after?: string;
    }) => Promise<StripeSubscriptionListPage>;
    cancel: (
      id: string,
      params?: Record<string, never>,
      options?: { idempotencyKey: string },
    ) => Promise<{ id?: string; status?: string }>;
  };
}

export interface StripeCancelDeps {
  loadStripeCustomerId?: (userId: string) => Promise<string | undefined>;
  getStripeClient?: () => Promise<StripeCancelClient>;
  getStripeConfig?: () => Promise<{ secretKey: string }>;
  loadSuperwallStripeSecret?: () => Promise<string | undefined>;
  createClient?: (secretKey: string) => StripeCancelClient;
  stripeConfigDeps?: StripeConfigDeps;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

export type StripeAccountCancelResult =
  | { status: 'SKIPPED'; reason: 'no_customer' | 'stripe_unconfigured' | 'no_subscriptions' }
  | { status: 'CANCELED'; canceledIds: string[] };

/**
 * Cancel every active / trialing / past_due Stripe subscription for the
 * account (WARDROBE-192) before DELETE /me wipes data.
 *
 * Uses the dedicated WARDROBE-187 secret via getStripeConfig /
 * getStripeClient. The optional Superwall `stripeSecretKey` is a
 * compatibility fallback only — prefer the dedicated secret.
 *
 * Immediate cancel (`subscriptions.cancel`), never cancel_at_period_end.
 * Missing customer, empty/placeholder Stripe secret, or no matching
 * subscriptions: proceed. `resource_missing` / already-canceled: proceed.
 * Any other Stripe cancel failure: throw BILLING_CANCEL_FAILED (503) and
 * do not delete the account.
 */
export async function cancelAccountStripeSubscriptions(
  input: { userId: string; stripeCustomerId?: string },
  deps: StripeCancelDeps = {},
): Promise<StripeAccountCancelResult> {
  const log = deps.log ?? logger;
  const customerId =
    input.stripeCustomerId?.trim() ||
    (await (deps.loadStripeCustomerId ?? loadStripeCustomerId)(input.userId));

  if (!customerId) {
    return { status: 'SKIPPED', reason: 'no_customer' };
  }

  const stripe = await resolveStripeCancelClient(deps, log);
  if (!stripe) {
    return { status: 'SKIPPED', reason: 'stripe_unconfigured' };
  }

  let subscriptionIds: string[];
  try {
    subscriptionIds = await listCancelableSubscriptionIds(stripe, customerId);
  } catch (error) {
    if (isIgnorableStripeCancelError(error)) {
      log.warn('Stripe subscription list skipped; customer or subs gone', {
        reason: stripeErrorCode(error) ?? 'already_canceled',
      });
      return { status: 'SKIPPED', reason: 'no_subscriptions' };
    }
    log.error('Stripe subscription list failed', safeCancelErrorFields(error));
    throw Errors.billingCancelFailed();
  }

  if (subscriptionIds.length === 0) {
    return { status: 'SKIPPED', reason: 'no_subscriptions' };
  }

  const canceledIds: string[] = [];
  for (const subscriptionId of subscriptionIds) {
    try {
      const canceled = await stripe.subscriptions.cancel(
        subscriptionId,
        {},
        { idempotencyKey: stripeSubscriptionCancelIdempotencyKey(subscriptionId) },
      );
      if (canceled.status && canceled.status !== 'canceled') {
        log.error('Stripe subscription cancel did not finish immediately', {
          reason: 'unexpected_status',
          subscriptionStatus: canceled.status,
        });
        throw Errors.billingCancelFailed();
      }
      canceledIds.push(subscriptionId);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (isIgnorableStripeCancelError(error)) {
        log.warn('Stripe subscription already canceled or missing', {
          reason: stripeErrorCode(error) ?? 'already_canceled',
        });
        continue;
      }
      log.error('Stripe subscription cancel failed', safeCancelErrorFields(error));
      throw Errors.billingCancelFailed();
    }
  }

  log.info('Stripe subscriptions canceled for account delete', {
    canceledCount: canceledIds.length,
  });
  return { status: 'CANCELED', canceledIds };
}

export async function resolveStripeCancelClient(
  deps: StripeCancelDeps,
  log: Pick<typeof logger, 'info' | 'warn' | 'error'> = logger,
): Promise<StripeCancelClient | undefined> {
  const dedicated = await tryDedicatedStripeClient(deps, log);
  if (dedicated) {
    return dedicated;
  }

  const fallbackKey = await (deps.loadSuperwallStripeSecret ??
    loadSuperwallStripeSecretFallback)();
  if (fallbackKey && !looksLikePlaceholderCredential(fallbackKey)) {
    log.info('Stripe cancel using Superwall stripeSecretKey fallback', {
      reason: 'superwall_fallback',
    });
    const create = deps.createClient ?? defaultCreateClient;
    return create(fallbackKey);
  }

  log.warn('Stripe cancel skipped; Stripe is not configured', {
    reason: 'stripe_unconfigured',
  });
  return undefined;
}

/**
 * `resource_missing` (no such customer/subscription) and already-canceled
 * subscriptions must not block account delete.
 */
export function isIgnorableStripeCancelError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : undefined;
  if (code === 'resource_missing') {
    return true;
  }
  const statusCode =
    typeof record.statusCode === 'number'
      ? record.statusCode
      : typeof record.status === 'number'
        ? record.status
        : undefined;
  if (statusCode === 404) {
    return true;
  }
  const status = typeof record.status === 'string' ? record.status : undefined;
  return status === 'canceled';
}

async function tryDedicatedStripeClient(
  deps: StripeCancelDeps,
  log: Pick<typeof logger, 'info' | 'warn' | 'error'>,
): Promise<StripeCancelClient | undefined> {
  try {
    if (deps.getStripeConfig) {
      const config = await deps.getStripeConfig();
      if (
        !config.secretKey?.trim() ||
        looksLikePlaceholderCredential(config.secretKey)
      ) {
        return undefined;
      }
    }
    if (deps.getStripeClient) {
      return await deps.getStripeClient();
    }
    if (deps.getStripeConfig) {
      return undefined;
    }
    await getStripeConfig(deps.stripeConfigDeps);
    return (await getStripeClient(deps.stripeConfigDeps)) as StripeCancelClient;
  } catch (error) {
    if (isStripeUnconfiguredError(error)) {
      return undefined;
    }
    log.error('Stripe cancel configuration failed', safeCancelErrorFields(error));
    throw Errors.billingCancelFailed();
  }
}

async function listCancelableSubscriptionIds(
  stripe: StripeCancelClient,
  customerId: string,
): Promise<string[]> {
  const ids = new Set<string>();
  for (const status of CANCELABLE_STRIPE_SUBSCRIPTION_STATUSES) {
    let startingAfter: string | undefined;
    do {
      const page = await stripe.subscriptions.list({
        customer: customerId,
        status,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const subscription of page.data) {
        const id = subscription.id?.trim();
        const subStatus = subscription.status?.trim();
        if (
          id &&
          subStatus &&
          (CANCELABLE_STRIPE_SUBSCRIPTION_STATUSES as readonly string[]).includes(
            subStatus,
          )
        ) {
          ids.add(id);
        }
      }
      const lastId = page.data.at(-1)?.id?.trim();
      startingAfter = page.has_more && lastId ? lastId : undefined;
    } while (startingAfter);
  }
  return [...ids];
}

/**
 * Compatibility fallback: Superwall secret `stripeSecretKey`.
 * Prefer the dedicated WARDROBE-187 secret. Never log the value.
 */
export async function loadSuperwallStripeSecretFallback(): Promise<
  string | undefined
> {
  const secretId = process.env.SUPERWALL_SECRET_ARN?.trim();
  if (!secretId) {
    return undefined;
  }
  try {
    const parsed = parseSuperwallSecret(await getSecretString(secretId));
    const key = parsed.stripeSecretKey?.trim();
    if (!key || looksLikePlaceholderCredential(key)) {
      return undefined;
    }
    return key;
  } catch (error) {
    logger.warn('Superwall Stripe fallback secret unreadable', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return undefined;
  }
}

function defaultCreateClient(secretKey: string): StripeCancelClient {
  return new Stripe(secretKey) as unknown as StripeCancelClient;
}

function stripeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code.trim() : undefined;
}

function safeCancelErrorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { errorName: 'UnknownError' };
  }
  return {
    errorName: error.name,
    reason: redactSecretMaterial(error.message),
  };
}

function redactSecretMaterial(value: string): string {
  return value
    .replace(/sk_(?:test|live)_[A-Za-z0-9]+/g, 'sk_[redacted]')
    .replace(/whsec_[A-Za-z0-9]+/g, 'whsec_[redacted]');
}
