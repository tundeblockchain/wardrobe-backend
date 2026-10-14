import {
  getItem,
  keys,
  setStripeCustomerIdIfAbsent,
} from './dynamodb';
import { Errors } from './errors';
import { logger } from './logger';
import { getStripeClient } from './stripe-config';
import { DynamoItem } from './types';

export const STRIPE_CUSTOMER_IDEMPOTENCY_PREFIX = 'customer-create-';

export function stripeCustomerIdempotencyKey(uid: string): string {
  return `${STRIPE_CUSTOMER_IDEMPOTENCY_PREFIX}${uid}`;
}

export interface StripeCustomerApi {
  customers: {
    create: (
      params: { metadata: { uid: string } },
      options: { idempotencyKey: string },
    ) => Promise<{ id: string }>;
  };
}

export interface StripeCustomerDeps {
  getItem?: (pk: string, sk: string) => Promise<DynamoItem | undefined>;
  setStripeCustomerIdIfAbsent?: (
    userId: string,
    stripeCustomerId: string,
  ) => Promise<boolean>;
  getStripeClient?: () => Promise<StripeCustomerApi>;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

export function readStripeCustomerId(
  item: DynamoItem | undefined,
): string | undefined {
  if (!item) {
    return undefined;
  }
  const value = item.stripeCustomerId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function loadStripeCustomerId(
  userId: string,
  deps: StripeCustomerDeps = {},
): Promise<string | undefined> {
  const load = deps.getItem ?? getItem;
  const item = await load(keys.userPk(userId), keys.profileSk);
  return readStripeCustomerId(item);
}

/**
 * One Stripe customer per Firebase uid.
 *
 * 1. Reuse `USER#{uid} / PROFILE.stripeCustomerId` when present.
 * 2. Otherwise create with `metadata.uid` and idempotency key
 *    `customer-create-${uid}`.
 * 3. Persist with `attribute_not_exists(stripeCustomerId)`. On
 *    ConditionalCheckFailed, re-read and use the stored id.
 */
export async function ensureStripeCustomer(
  userId: string,
  deps: StripeCustomerDeps = {},
): Promise<string> {
  const existing = await loadStripeCustomerId(userId, deps);
  if (existing) {
    return existing;
  }

  const getClient = deps.getStripeClient ?? (() => getStripeClient());
  const stripe = await getClient();
  const customer = await stripe.customers.create(
    { metadata: { uid: userId } },
    { idempotencyKey: stripeCustomerIdempotencyKey(userId) },
  );
  const createdId = customer.id?.trim();
  if (!createdId) {
    throw Errors.internal('Stripe customer create did not return an id.');
  }

  const persist = deps.setStripeCustomerIdIfAbsent ?? setStripeCustomerIdIfAbsent;
  const wrote = await persist(userId, createdId);
  if (wrote) {
    const log = deps.log ?? logger;
    log.info('Stripe customer persisted', { customerId: createdId });
    return createdId;
  }

  const stored = await loadStripeCustomerId(userId, deps);
  if (stored) {
    return stored;
  }
  throw Errors.internal(
    'stripeCustomerId missing after conditional write conflict.',
  );
}
