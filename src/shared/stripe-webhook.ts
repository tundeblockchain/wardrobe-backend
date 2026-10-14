import { APIGatewayProxyEventV2 } from 'aws-lambda';
import Stripe from 'stripe';
import {
  deleteItem,
  getItem,
  keys,
  putItemIfNotExists,
} from './dynamodb';
import {
  clearStripePaidTier,
  setPaidTierStatus,
} from './entitlements';
import { AppError, Errors } from './errors';
import { nowIso } from './ids';
import { logger } from './logger';
import { isPaidTier, normalizePaidTier } from './paid-tier';
import { StripeLookupKeys } from './stripe-plans';
import { PaidTier } from './types';

export const STRIPE_WEBHOOK_EVENT_TYPES = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
] as const;

export type StripeWebhookEventType = (typeof STRIPE_WEBHOOK_EVENT_TYPES)[number];

export const STRIPE_WEBHOOK_EVENT_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Paid access stays up. `past_due` means Stripe is retrying payment. */
const GRANT_STATUSES = new Set(['active', 'trialing', 'past_due']);
const CLEAR_STATUSES = new Set([
  'canceled',
  'unpaid',
  'incomplete_expired',
  'ended',
]);

export interface StripeSubscriptionLike {
  id?: string;
  status?: string;
  customer?: string | { id?: string; metadata?: Record<string, unknown> };
  metadata?: Record<string, unknown>;
  current_period_end?: number;
  ended_at?: number | null;
  deleted?: boolean;
  items?: {
    data?: Array<{
      current_period_end?: number;
      price?:
        | string
        | {
            id?: string;
            lookup_key?: string | null;
          };
    }>;
  };
}

export interface StripeCustomerLike {
  id?: string;
  metadata?: Record<string, unknown>;
}

export interface StripeWebhookClient {
  subscriptions: {
    retrieve: (
      id: string,
      params?: { expand?: string[] },
    ) => Promise<StripeSubscriptionLike>;
  };
  customers: {
    retrieve: (id: string) => Promise<StripeCustomerLike>;
  };
}

export interface StripeWebhookApplyDeps {
  setPaidTierStatus?: typeof setPaidTierStatus;
  clearStripePaidTier?: typeof clearStripePaidTier;
  persistStripeCustomerMapping?: (
    customerId: string,
    userId: string,
  ) => Promise<boolean>;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
  nowIso?: string;
  nowMs?: number;
}

/**
 * Decoded request bytes for Stripe-Signature verification.
 * Base64-decode when API Gateway sets `isBase64Encoded`. Never JSON-parse.
 */
export function rawWebhookPayload(event: APIGatewayProxyEventV2): Buffer {
  if (!event.body) {
    throw Errors.validation('Request body is required.');
  }
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, 'base64');
  }
  return Buffer.from(event.body, 'utf8');
}

export function stripeSignatureHeader(
  event: APIGatewayProxyEventV2,
): string | undefined {
  const headers = event.headers ?? {};
  for (const [key, value] of Object.entries(headers)) {
    if (
      key.toLowerCase() === 'stripe-signature' &&
      typeof value === 'string' &&
      value.trim()
    ) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * HMAC-verify `Stripe-Signature` against the decoded raw payload bytes.
 * Call this before any JSON.parse of the webhook body.
 */
export function verifyStripeWebhookSignature(options: {
  payload: Buffer | string;
  signature: string | undefined;
  webhookSecret: string;
}): Stripe.Event {
  if (!options.signature?.trim()) {
    throw Errors.validation('Missing Stripe-Signature header.');
  }
  if (!options.webhookSecret?.trim()) {
    throw Errors.validation('Invalid Stripe webhook signature.');
  }
  try {
    return Stripe.webhooks.constructEvent(
      options.payload,
      options.signature.trim(),
      options.webhookSecret,
    );
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw Errors.validation('Invalid Stripe webhook signature.');
  }
}

export function isStripeWebhookEventType(
  value: string,
): value is StripeWebhookEventType {
  return (STRIPE_WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

export function stripeEventId(event: { id?: unknown }): string | undefined {
  return optionalString(event.id);
}

export function subscriptionIdFromStripeEvent(event: {
  type?: string;
  data?: { object?: unknown };
}): string | undefined {
  const object = asRecord(event.data?.object);
  if (!object) {
    return undefined;
  }
  if (event.type === 'checkout.session.completed') {
    return idOf(object.subscription);
  }
  if (typeof event.type === 'string' && event.type.startsWith('customer.subscription.')) {
    return optionalString(object.id) ?? idOf(object);
  }
  return idOf(object.subscription) ?? optionalString(object.id);
}

export async function retrieveStripeSubscription(
  stripe: StripeWebhookClient,
  subscriptionId: string,
): Promise<StripeSubscriptionLike> {
  return stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['items.data.price', 'customer'],
  });
}

export async function resolveStripeWebhookUid(options: {
  subscription: StripeSubscriptionLike;
  stripe: StripeWebhookClient;
  loadUidByStripeCustomerId?: (
    customerId: string,
  ) => Promise<string | undefined>;
}): Promise<{ userId?: string; customerId?: string }> {
  const customerId = customerIdOf(options.subscription);
  const fromSubscription = metadataUid(options.subscription.metadata);
  if (fromSubscription) {
    return { userId: fromSubscription, customerId };
  }

  const customer = await resolveCustomer(options.stripe, options.subscription);
  const fromCustomer = metadataUid(customer?.metadata);
  if (fromCustomer) {
    return { userId: fromCustomer, customerId: customerId ?? optionalString(customer?.id) };
  }

  const resolvedCustomerId = customerId ?? optionalString(customer?.id);
  if (resolvedCustomerId && options.loadUidByStripeCustomerId) {
    const mapped = await options.loadUidByStripeCustomerId(resolvedCustomerId);
    if (mapped) {
      return { userId: mapped, customerId: resolvedCustomerId };
    }
  }

  return { userId: undefined, customerId: resolvedCustomerId };
}

export function paidTierFromStripeSubscription(
  subscription: StripeSubscriptionLike,
  lookupKeys: StripeLookupKeys,
): PaidTier | undefined {
  const lookupKey = lookupKeyFromSubscription(subscription);
  if (lookupKey === lookupKeys.premiumMonthly) {
    return 'premium';
  }
  if (lookupKey === lookupKeys.basicMonthly) {
    return 'basic';
  }
  return normalizePaidTier(subscription.metadata?.tier);
}

export function currentPeriodEndIso(
  subscription: StripeSubscriptionLike,
): string | undefined {
  const seconds =
    unixSeconds(subscription.current_period_end) ??
    unixSeconds(subscription.items?.data?.[0]?.current_period_end);
  if (seconds === undefined) {
    return undefined;
  }
  return new Date(seconds * 1000).toISOString();
}

export function isStripeGrantStatus(subscription: StripeSubscriptionLike): boolean {
  const status = optionalString(subscription.status)?.toLowerCase();
  return Boolean(status && GRANT_STATUSES.has(status));
}

export function isStripeClearStatus(subscription: StripeSubscriptionLike): boolean {
  if (subscription.deleted === true) {
    return true;
  }
  const status = optionalString(subscription.status)?.toLowerCase();
  if (status && CLEAR_STATUSES.has(status)) {
    return true;
  }
  return typeof subscription.ended_at === 'number' && subscription.ended_at > 0;
}

export async function recordStripeEventIfNew(
  eventId: string,
  options?: { nowSeconds?: number; ttlSeconds?: number },
): Promise<boolean> {
  const id = eventId.trim();
  if (!id) {
    return false;
  }
  const nowSeconds = options?.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttlSeconds = options?.ttlSeconds ?? STRIPE_WEBHOOK_EVENT_TTL_SECONDS;
  const timestamp = nowIso();
  return putItemIfNotExists({
    PK: keys.stripeEventPk(id),
    SK: keys.stripeEventSk,
    entityType: 'STRIPE_EVENT',
    userId: 'stripe',
    eventId: id,
    createdAt: timestamp,
    updatedAt: timestamp,
    ttl: nowSeconds + ttlSeconds,
  });
}

export async function forgetStripeEvent(eventId: string): Promise<void> {
  const id = eventId.trim();
  if (!id) {
    return;
  }
  await deleteItem(keys.stripeEventPk(id), keys.stripeEventSk);
}

export async function loadUidByStripeCustomerId(
  stripeCustomerId: string,
): Promise<string | undefined> {
  const id = stripeCustomerId.trim();
  if (!id) {
    return undefined;
  }
  const item = await getItem(keys.stripeCustomerPk(id), keys.stripeCustomerSk);
  if (!item || item.entityType !== 'STRIPE_CUSTOMER') {
    return undefined;
  }
  return optionalString(item.userId);
}

export async function persistStripeCustomerMapping(
  stripeCustomerId: string,
  userId: string,
): Promise<boolean> {
  const customerId = stripeCustomerId.trim();
  const uid = userId.trim();
  if (!customerId || !uid) {
    return false;
  }
  const timestamp = nowIso();
  return putItemIfNotExists({
    PK: keys.stripeCustomerPk(customerId),
    SK: keys.stripeCustomerSk,
    entityType: 'STRIPE_CUSTOMER',
    userId: uid,
    stripeCustomerId: customerId,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export async function applyStripeSubscriptionState(options: {
  userId: string;
  subscription: StripeSubscriptionLike;
  lookupKeys: StripeLookupKeys;
  eventId?: string;
  eventAtMs?: number;
} & StripeWebhookApplyDeps): Promise<{
  status: 'applied' | 'cleared' | 'clash' | 'ignored';
  reason?: string;
  tier?: PaidTier;
}> {
  const log = options.log ?? logger;
  const setTier = options.setPaidTierStatus ?? setPaidTierStatus;
  const clearTier = options.clearStripePaidTier ?? clearStripePaidTier;
  const persistMapping =
    options.persistStripeCustomerMapping ?? persistStripeCustomerMapping;
  const customerId = customerIdOf(options.subscription);
  if (customerId) {
    await persistMapping(customerId, options.userId);
  }

  if (isStripeGrantStatus(options.subscription)) {
    const tier = paidTierFromStripeSubscription(
      options.subscription,
      options.lookupKeys,
    );
    if (!tier || !isPaidTier(tier)) {
      log.warn('Stripe webhook ignored; price lookup key does not map to a paid tier', {
        uid: options.userId,
        stripeSubscriptionId: options.subscription.id,
      });
      return { status: 'ignored', reason: 'unknown_price' };
    }

    const result = await setTier({
      userId: options.userId,
      tier,
      source: 'stripe',
      expiresAt: currentPeriodEndIso(options.subscription),
      productId: lookupKeyFromSubscription(options.subscription),
      originalTransactionId: optionalString(options.subscription.id),
      lastEventId: options.eventId,
      lastEventAt: options.eventAtMs,
      nowIso: options.nowIso,
      nowMs: options.nowMs,
    });

    if (!result.applied && result.reason === 'source_clash') {
      log.warn('Paid-tier source clash; keeping existing plan', {
        uid: options.userId,
        existingSource: result.stored.source,
        stripeSubscriptionId: options.subscription.id,
      });
      return {
        status: 'clash',
        reason: 'source_clash',
        tier,
      };
    }

    return { status: 'applied', reason: result.reason, tier };
  }

  if (isStripeClearStatus(options.subscription)) {
    const result = await clearTier({
      userId: options.userId,
      lastEventId: options.eventId,
      lastEventAt: options.eventAtMs,
      nowIso: options.nowIso,
      nowMs: options.nowMs,
    });
    if (result.cleared) {
      return { status: 'cleared', reason: 'cleared' };
    }
    return { status: 'ignored', reason: result.reason };
  }

  return { status: 'ignored', reason: 'unhandled_status' };
}

async function resolveCustomer(
  stripe: StripeWebhookClient,
  subscription: StripeSubscriptionLike,
): Promise<StripeCustomerLike | undefined> {
  if (subscription.customer && typeof subscription.customer === 'object') {
    return subscription.customer;
  }
  const customerId = customerIdOf(subscription);
  if (!customerId) {
    return undefined;
  }
  return stripe.customers.retrieve(customerId);
}

function lookupKeyFromSubscription(
  subscription: StripeSubscriptionLike,
): string | undefined {
  const price = subscription.items?.data?.[0]?.price;
  if (!price || typeof price === 'string') {
    return undefined;
  }
  return optionalString(price.lookup_key);
}

function customerIdOf(subscription: StripeSubscriptionLike): string | undefined {
  return idOf(subscription.customer);
}

function metadataUid(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) {
    return undefined;
  }
  return optionalString(metadata.uid);
}

function idOf(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return optionalString(value);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return optionalString((value as { id?: unknown }).id);
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function unixSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
