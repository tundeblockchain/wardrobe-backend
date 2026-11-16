import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  superwallIsTrialStart,
  stripeMinorToMajor,
  isStripeFreeTrialCheckout,
} from './conversion-events';
import { deleteItem, keys, putItemIfNotExists } from './dynamodb';
import { SuperwallWebhookEvent, superwallEventName } from './entitlements';
import { nowIso } from './ids';
import { logger } from './logger';
import type { StripeLookupKeys, StripePriceIds } from './stripe-plans';
import {
  paidTierFromStripeSubscription,
  type StripeSubscriptionLike,
} from './stripe-webhook';
import { OWNER_NOTIFY_JOB } from './types';

export const OWNER_NOTIFY_QUEUE_URL_ENV = 'OWNER_NOTIFY_QUEUE_URL';
export const OWNER_NOTIFY_RECIPIENT_PARAM_ENV = 'OWNER_NOTIFY_RECIPIENT_PARAM';
export const OWNER_NOTIFY_SENDER_PARAM_ENV = 'OWNER_NOTIFY_SENDER_PARAM';

export const OWNER_NOTIFY_EVENT_TTL_SECONDS = 90 * 24 * 60 * 60;

const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type OwnerNotifyEventType =
  | 'subscribed'
  | 'trial_started'
  | 'canceled'
  | 'expired';

export type OwnerNotifyPlatform = 'web' | 'ios' | 'android';
export type OwnerNotifyProvider = 'stripe' | 'superwall';

export interface OwnerNotifyMessage {
  jobType: typeof OWNER_NOTIFY_JOB;
  eventType: OwnerNotifyEventType;
  plan?: string;
  platform: OwnerNotifyPlatform;
  price?: number;
  currency?: string;
  userEmail?: string;
  userId?: string;
  eventTimestamp: string;
  provider: OwnerNotifyProvider;
  providerEventId: string;
}

export interface OwnerNotifyConfig {
  recipient: string;
  sender: string;
}

export interface OwnerNotifyEnqueueDeps {
  env?: NodeJS.ProcessEnv;
  sqsSend?: (input: { QueueUrl: string; MessageBody: string }) => Promise<unknown>;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
  notifyOwner?: (message: OwnerNotifyMessage) => Promise<void>;
}

export interface OwnerNotifySendDeps {
  env?: NodeJS.ProcessEnv;
  nowSeconds?: number;
  ttlSeconds?: number;
  claimEvent?: (message: OwnerNotifyMessage) => Promise<boolean>;
  forgetEvent?: (message: OwnerNotifyMessage) => Promise<void>;
  loadConfig?: () => Promise<OwnerNotifyConfig | undefined>;
  sendEmail?: (input: {
    sender: string;
    recipient: string;
    subject: string;
    text: string;
    html: string;
  }) => Promise<void>;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

export interface OwnerNotifySsmDeps {
  env?: NodeJS.ProcessEnv;
  getParameter?: (name: string) => Promise<string | undefined>;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

const sqs = new SQSClient({});
const ssm = new SSMClient({});
const ses = new SESClient({});

let cachedConfig:
  | { recipientParam: string; senderParam: string; config: OwnerNotifyConfig }
  | undefined;

export function ownerNotifyRecipientParamName(stage: string): string {
  return `/wardrobe/${stage.trim()}/owner-notify/recipient`;
}

export function ownerNotifySenderParamName(stage: string): string {
  return `/wardrobe/${stage.trim()}/owner-notify/sender`;
}

export function resetOwnerNotifyConfigCache(): void {
  cachedConfig = undefined;
}

/**
 * Map a verified Stripe webhook onto an owner-notify payload.
 * Subscribe / trial: checkout.session.completed and customer.subscription.created.
 * Cancellation: cancel_at_period_end flipping to true, or a clear/deleted sub.
 * Expiry: customer.subscription.deleted after a scheduled cancel (or ended).
 */
export function mapStripeOwnerNotify(options: {
  type: string;
  eventId?: string;
  created?: number;
  object?: Record<string, unknown>;
  previousAttributes?: Record<string, unknown>;
  subscription?: StripeSubscriptionLike;
  userId?: string;
  lookupKeys?: StripeLookupKeys;
  priceIds?: StripePriceIds;
}): OwnerNotifyMessage | undefined {
  const providerEventId = optionalString(options.eventId);
  if (!providerEventId) {
    return undefined;
  }

  const object = options.object;
  const subscription =
    options.subscription ?? subscriptionFromObject(object);
  const eventType = stripeOwnerEventType(
    options.type,
    object,
    subscription,
    options.previousAttributes,
  );
  if (!eventType) {
    return undefined;
  }

  const money = stripeOwnerMoney(options.type, object, subscription);
  const plan = stripeOwnerPlan(subscription, object, options.lookupKeys, options.priceIds);
  const userEmail = stripeOwnerEmail(object, subscription);
  const userId = optionalString(options.userId) ?? stripeObjectUid(object, subscription);

  return buildOwnerNotifyMessage({
    eventType,
    plan,
    platform: 'web',
    price: money.price,
    currency: money.currency,
    userEmail,
    userId,
    eventTimestamp: isoFromUnixSeconds(options.created) ?? nowIso(),
    provider: 'stripe',
    providerEventId,
  });
}

/**
 * Map a verified Superwall webhook onto an owner-notify payload.
 * initial_purchase (paid / trial), cancellation, expiration.
 */
export function mapSuperwallOwnerNotify(
  event: SuperwallWebhookEvent,
  userId?: string,
  nowSeconds?: number,
): OwnerNotifyMessage | undefined {
  const name = superwallEventName(event).trim().toLowerCase();
  const eventType = superwallOwnerEventType(name, event.data);
  if (!eventType) {
    return undefined;
  }

  const data = asRecord(event.data);
  const providerEventId =
    optionalString(data?.id) ??
    optionalString((data as { eventId?: unknown } | undefined)?.eventId);
  if (!providerEventId) {
    return undefined;
  }

  const platform = superwallOwnerPlatform(data?.store);
  const money = superwallOwnerMoney(data);
  const plan = superwallOwnerPlan(data);
  const userEmail = superwallOwnerEmail(data);
  const resolvedUserId = optionalString(userId);
  const timestamp = superwallOwnerTimestamp(event, nowSeconds);

  return buildOwnerNotifyMessage({
    eventType,
    plan,
    platform,
    price: money.price,
    currency: money.currency,
    userEmail,
    userId: resolvedUserId,
    eventTimestamp: timestamp,
    provider: 'superwall',
    providerEventId,
  });
}

export function formatOwnerNotifyEmail(message: OwnerNotifyMessage): {
  subject: string;
  text: string;
  html: string;
} {
  const user = message.userEmail ?? message.userId ?? 'unknown';
  const price = formatOwnerNotifyPrice(message.price, message.currency);
  const plan = message.plan ?? 'unknown';
  const lines = [
    `Event type: ${message.eventType}`,
    `Plan: ${plan}`,
    `Platform: ${message.platform}`,
    `Price: ${price}`,
    `User: ${user}`,
    `Event time: ${message.eventTimestamp}`,
    `Provider event ID: ${message.providerEventId}`,
  ];
  const text = lines.join('\n');
  const subject = `Wardrobe ${message.eventType}: ${plan} (${message.platform})`;
  const html = `<html><body><pre>${escapeHtml(text)}</pre></body></html>`;
  return { subject, text, html };
}

export function parseOwnerNotifyMessage(
  body: string,
): OwnerNotifyMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.jobType !== OWNER_NOTIFY_JOB) {
    return undefined;
  }
  const eventType = raw.eventType;
  if (!isOwnerNotifyEventType(eventType)) {
    return undefined;
  }
  const platform = raw.platform;
  if (!isOwnerNotifyPlatform(platform)) {
    return undefined;
  }
  const provider = raw.provider;
  if (!isOwnerNotifyProvider(provider)) {
    return undefined;
  }
  const providerEventId = optionalString(raw.providerEventId);
  const eventTimestamp = optionalString(raw.eventTimestamp);
  if (!providerEventId || !eventTimestamp) {
    return undefined;
  }

  return buildOwnerNotifyMessage({
    eventType,
    plan: optionalString(raw.plan),
    platform,
    price: finiteNumber(raw.price),
    currency: optionalString(raw.currency)?.toUpperCase(),
    userEmail: optionalString(raw.userEmail),
    userId: optionalString(raw.userId),
    eventTimestamp,
    provider,
    providerEventId,
  });
}

/**
 * Best-effort enqueue. Never throws. Missing queue URL logs a warning
 * and returns so webhook tests and undeployed stages stay quiet.
 */
export async function enqueueOwnerNotify(
  message: OwnerNotifyMessage | undefined,
  deps: OwnerNotifyEnqueueDeps = {},
): Promise<void> {
  if (!message) {
    return;
  }
  const log = deps.log ?? logger;
  try {
    if (deps.notifyOwner) {
      await deps.notifyOwner(message);
      return;
    }
    const env = deps.env ?? process.env;
    const queueUrl = env[OWNER_NOTIFY_QUEUE_URL_ENV]?.trim();
    if (!queueUrl) {
      log.warn('Owner notify skipped; queue is not configured', {
        provider: message.provider,
        providerEventId: message.providerEventId,
        eventType: message.eventType,
      });
      return;
    }
    const send =
      deps.sqsSend ??
      ((input: { QueueUrl: string; MessageBody: string }) =>
        sqs.send(new SendMessageCommand(input)));
    await send({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
    });
    log.info('Owner notify enqueued', {
      provider: message.provider,
      providerEventId: message.providerEventId,
      eventType: message.eventType,
      platform: message.platform,
    });
  } catch (error) {
    log.error('Owner notify enqueue failed', {
      provider: message.provider,
      providerEventId: message.providerEventId,
      eventType: message.eventType,
      error: safeErrorMessage(error),
    });
  }
}

export async function claimOwnerNotifyEvent(
  message: OwnerNotifyMessage,
  options?: { nowSeconds?: number; ttlSeconds?: number },
): Promise<boolean> {
  const providerEventId = message.providerEventId.trim();
  if (!providerEventId) {
    return false;
  }
  const nowSeconds = options?.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttlSeconds = options?.ttlSeconds ?? OWNER_NOTIFY_EVENT_TTL_SECONDS;
  const timestamp = nowIso();
  return putItemIfNotExists({
    PK: keys.ownerNotifyPk(message.provider, providerEventId),
    SK: keys.ownerNotifySk,
    entityType: 'OWNER_NOTIFY',
    userId: message.userId ?? message.provider,
    eventId: providerEventId,
    provider: message.provider,
    createdAt: timestamp,
    updatedAt: timestamp,
    ttl: nowSeconds + ttlSeconds,
  });
}

export async function forgetOwnerNotifyEvent(
  message: OwnerNotifyMessage,
): Promise<void> {
  const providerEventId = message.providerEventId.trim();
  if (!providerEventId) {
    return;
  }
  await deleteItem(
    keys.ownerNotifyPk(message.provider, providerEventId),
    keys.ownerNotifySk,
  );
}

export async function loadOwnerNotifyConfig(
  deps: OwnerNotifySsmDeps = {},
): Promise<OwnerNotifyConfig | undefined> {
  const log = deps.log ?? logger;
  const env = deps.env ?? process.env;
  const recipientParam = env[OWNER_NOTIFY_RECIPIENT_PARAM_ENV]?.trim();
  const senderParam = env[OWNER_NOTIFY_SENDER_PARAM_ENV]?.trim();
  if (!recipientParam || !senderParam) {
    log.warn('Owner notify skipped; SSM parameter names are not configured');
    return undefined;
  }

  if (
    cachedConfig &&
    cachedConfig.recipientParam === recipientParam &&
    cachedConfig.senderParam === senderParam
  ) {
    return cachedConfig.config;
  }

  const getParameter = deps.getParameter ?? getSsmParameter;
  let recipient: string | undefined;
  let sender: string | undefined;
  try {
    [recipient, sender] = await Promise.all([
      getParameter(recipientParam),
      getParameter(senderParam),
    ]);
  } catch (error) {
    log.warn('Owner notify skipped; failed to read SSM parameters', {
      error: safeErrorMessage(error),
    });
    return undefined;
  }

  if (!isNotifyEmail(recipient) || !isNotifyEmail(sender)) {
    log.warn('Owner notify skipped; sender or recipient is missing or invalid');
    return undefined;
  }

  const config = { recipient, sender };
  cachedConfig = { recipientParam, senderParam, config };
  return config;
}

/**
 * Dedupe, load SSM, send SES. Throws only after forgetting a claim so
 * SQS can retry SES failures. Missing config is a quiet skip (acked).
 */
export async function sendOwnerNotify(
  message: OwnerNotifyMessage,
  deps: OwnerNotifySendDeps = {},
): Promise<void> {
  const log = deps.log ?? logger;
  const claim = deps.claimEvent ?? claimOwnerNotifyEvent;
  const forget = deps.forgetEvent ?? forgetOwnerNotifyEvent;
  const claimed = await claim(message, {
    nowSeconds: deps.nowSeconds,
    ttlSeconds: deps.ttlSeconds,
  });
  if (!claimed) {
    log.info('Owner notify skipped; event already sent', {
      provider: message.provider,
      providerEventId: message.providerEventId,
      eventType: message.eventType,
    });
    return;
  }

  const loadConfig = deps.loadConfig ?? (() => loadOwnerNotifyConfig({ log }));
  let config: OwnerNotifyConfig | undefined;
  try {
    config = await loadConfig();
  } catch (error) {
    log.warn('Owner notify skipped; failed to load config', {
      provider: message.provider,
      providerEventId: message.providerEventId,
      error: safeErrorMessage(error),
    });
    await forget(message);
    return;
  }
  if (!config) {
    await forget(message);
    return;
  }

  const email = formatOwnerNotifyEmail(message);
  const send =
    deps.sendEmail ??
    ((input: {
      sender: string;
      recipient: string;
      subject: string;
      text: string;
      html: string;
    }) => sendSesEmail(input));
  try {
    await send({
      sender: config.sender,
      recipient: config.recipient,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    log.info('Owner notify sent', {
      provider: message.provider,
      providerEventId: message.providerEventId,
      eventType: message.eventType,
      platform: message.platform,
    });
  } catch (error) {
    log.error('Owner notify SES send failed', {
      provider: message.provider,
      providerEventId: message.providerEventId,
      eventType: message.eventType,
      error: safeErrorMessage(error),
    });
    try {
      await forget(message);
    } catch (forgetError) {
      log.error('Owner notify failed to release dedupe claim', {
        provider: message.provider,
        providerEventId: message.providerEventId,
        error: safeErrorMessage(forgetError),
      });
    }
    throw error;
  }
}

function stripeOwnerEventType(
  type: string,
  object: Record<string, unknown> | undefined,
  subscription: StripeSubscriptionLike | undefined,
  previousAttributes: Record<string, unknown> | undefined,
): OwnerNotifyEventType | undefined {
  if (type === 'checkout.session.completed') {
    const money = stripeOwnerMoney(type, object, subscription);
    return isStripeFreeTrialCheckout(subscription, money.price)
      ? 'trial_started'
      : 'subscribed';
  }
  if (type === 'customer.subscription.created') {
    const status = optionalString(subscription?.status)?.toLowerCase();
    const money = stripeOwnerMoney(type, object, subscription);
    if (status === 'trialing' && (money.price === undefined || money.price === 0)) {
      return 'trial_started';
    }
    return 'subscribed';
  }
  if (type === 'customer.subscription.updated') {
    const cancelAtPeriodEnd = subscription?.cancel_at_period_end === true;
    if (cancelAtPeriodEnd && previousAttributes?.cancel_at_period_end === false) {
      return 'canceled';
    }
    const status = optionalString(subscription?.status)?.toLowerCase();
    if (status === 'canceled' || status === 'unpaid' || status === 'incomplete_expired') {
      return 'canceled';
    }
    return undefined;
  }
  if (type === 'customer.subscription.deleted') {
    return subscription?.cancel_at_period_end === true ? 'expired' : 'canceled';
  }
  return undefined;
}

function stripeOwnerMoney(
  type: string,
  object: Record<string, unknown> | undefined,
  subscription: StripeSubscriptionLike | undefined,
): { price?: number; currency?: string } {
  if (type === 'checkout.session.completed' && object) {
    const currency = optionalString(object.currency)?.toUpperCase();
    const amount = finiteNumber(object.amount_total);
    if (amount === undefined) {
      return { currency };
    }
    return {
      price: stripeMinorToMajor(amount, optionalString(object.currency)),
      currency,
    };
  }
  const price = subscriptionPrice(subscription);
  if (!price || typeof price === 'string') {
    return {};
  }
  const currency = optionalString(price.currency)?.toUpperCase();
  const amount = finiteNumber(price.unit_amount);
  if (amount === undefined) {
    return { currency };
  }
  return {
    price: stripeMinorToMajor(amount, optionalString(price.currency)),
    currency,
  };
}

function stripeOwnerPlan(
  subscription: StripeSubscriptionLike | undefined,
  object: Record<string, unknown> | undefined,
  lookupKeys?: StripeLookupKeys,
  priceIds?: StripePriceIds,
): string | undefined {
  if (subscription && lookupKeys) {
    const tier = paidTierFromStripeSubscription(subscription, lookupKeys, priceIds);
    if (tier) {
      return tier;
    }
  }
  const price = subscriptionPrice(subscription);
  if (price && typeof price !== 'string') {
    const lookupKey = optionalString(price.lookup_key);
    if (lookupKey) {
      return lookupKey;
    }
  }
  const metadata = asRecord(subscription?.metadata) ?? asRecord(object?.metadata);
  return optionalString(metadata?.tier) ?? optionalString(object?.lookup_key);
}

function stripeOwnerEmail(
  object: Record<string, unknown> | undefined,
  subscription: StripeSubscriptionLike | undefined,
): string | undefined {
  const details = asRecord(object?.customer_details);
  const fromDetails = optionalString(details?.email);
  if (fromDetails) {
    return fromDetails;
  }
  const fromSession = optionalString(object?.customer_email);
  if (fromSession) {
    return fromSession;
  }
  const customer = subscription?.customer;
  if (customer && typeof customer === 'object') {
    return optionalString(customer.email);
  }
  const objectCustomer = object?.customer;
  if (objectCustomer && typeof objectCustomer === 'object' && !Array.isArray(objectCustomer)) {
    return optionalString((objectCustomer as { email?: unknown }).email);
  }
  return undefined;
}

function stripeObjectUid(
  object: Record<string, unknown> | undefined,
  subscription: StripeSubscriptionLike | undefined,
): string | undefined {
  const fromSub = optionalString(asRecord(subscription?.metadata)?.uid);
  if (fromSub) {
    return fromSub;
  }
  return optionalString(asRecord(object?.metadata)?.uid);
}

function subscriptionFromObject(
  object: Record<string, unknown> | undefined,
): StripeSubscriptionLike | undefined {
  if (!object) {
    return undefined;
  }
  return object as StripeSubscriptionLike;
}

function subscriptionPrice(
  subscription: StripeSubscriptionLike | undefined,
):
  | string
  | {
      id?: string;
      lookup_key?: string | null;
      unit_amount?: number | null;
      currency?: string | null;
    }
  | undefined {
  return subscription?.items?.data?.[0]?.price;
}

function superwallOwnerEventType(
  name: string,
  data: unknown,
): OwnerNotifyEventType | undefined {
  if (name === 'initial_purchase') {
    return superwallIsTrialStart(data) ? 'trial_started' : 'subscribed';
  }
  if (name === 'cancellation') {
    return 'canceled';
  }
  if (name === 'expiration') {
    return 'expired';
  }
  return undefined;
}

function superwallOwnerPlatform(store: unknown): OwnerNotifyPlatform {
  const raw = optionalString(store)?.toUpperCase() ?? '';
  if (raw === 'PLAY_STORE' || raw.includes('PLAY') || raw.includes('GOOGLE')) {
    return 'android';
  }
  if (raw === 'STRIPE' || raw.includes('STRIPE') || raw.includes('WEB')) {
    return 'web';
  }
  return 'ios';
}

function superwallOwnerMoney(
  data: Record<string, unknown> | undefined,
): { price?: number; currency?: string } {
  if (!data) {
    return {};
  }
  const currency = optionalString(
    data.currencyCode ?? data.currency_code ?? data.currency,
  )?.toUpperCase();
  const price = firstFiniteNumber(
    data.priceInPurchasedCurrency,
    data.price_in_purchased_currency,
    data.price,
  );
  return { price, currency };
}

function superwallOwnerPlan(
  data: Record<string, unknown> | undefined,
): string | undefined {
  if (!data) {
    return undefined;
  }
  return (
    optionalString(data.newProductId) ??
    optionalString(data.productId) ??
    optionalString(data.product_id)
  );
}

function superwallOwnerEmail(
  data: Record<string, unknown> | undefined,
): string | undefined {
  const attributes = asRecord(data?.userAttributes) ?? asRecord(data?.user_attributes);
  if (!attributes) {
    return undefined;
  }
  return (
    optionalString(attributes.email) ??
    optionalString(attributes.emailAddress) ??
    optionalString(attributes.email_address)
  );
}

function superwallOwnerTimestamp(
  event: SuperwallWebhookEvent,
  nowSeconds?: number,
): string {
  const data = asRecord(event.data);
  const fromData = unixToIso(
    firstFiniteNumber(data?.purchasedAt, data?.ts, event.timestamp),
  );
  if (fromData) {
    return fromData;
  }
  if (typeof nowSeconds === 'number' && Number.isFinite(nowSeconds) && nowSeconds > 0) {
    const seconds = nowSeconds > 1e12 ? Math.floor(nowSeconds / 1000) : Math.floor(nowSeconds);
    return new Date(seconds * 1000).toISOString();
  }
  return nowIso();
}

function buildOwnerNotifyMessage(options: {
  eventType: OwnerNotifyEventType;
  plan?: string;
  platform: OwnerNotifyPlatform;
  price?: number;
  currency?: string;
  userEmail?: string;
  userId?: string;
  eventTimestamp: string;
  provider: OwnerNotifyProvider;
  providerEventId: string;
}): OwnerNotifyMessage {
  const message: OwnerNotifyMessage = {
    jobType: OWNER_NOTIFY_JOB,
    eventType: options.eventType,
    platform: options.platform,
    eventTimestamp: options.eventTimestamp,
    provider: options.provider,
    providerEventId: options.providerEventId,
  };
  if (options.plan) {
    message.plan = options.plan;
  }
  if (typeof options.price === 'number' && Number.isFinite(options.price)) {
    message.price = options.price;
  }
  if (options.currency) {
    message.currency = options.currency;
  }
  if (options.userEmail) {
    message.userEmail = options.userEmail;
  }
  if (options.userId) {
    message.userId = options.userId;
  }
  return message;
}

function formatOwnerNotifyPrice(
  price: number | undefined,
  currency: string | undefined,
): string {
  if (typeof price === 'number' && Number.isFinite(price)) {
    const amount = Number.isInteger(price) ? String(price) : String(price);
    return currency ? `${amount} ${currency}` : amount;
  }
  return currency ?? 'unknown';
}

async function getSsmParameter(name: string): Promise<string | undefined> {
  try {
    const result = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    return result.Parameter?.Value?.trim() || undefined;
  } catch (error) {
    if (isSsmMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

async function sendSesEmail(input: {
  sender: string;
  recipient: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  await ses.send(
    new SendEmailCommand({
      Source: input.sender,
      Destination: { ToAddresses: [input.recipient] },
      Message: {
        Subject: { Data: input.subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: input.text, Charset: 'UTF-8' },
          Html: { Data: input.html, Charset: 'UTF-8' },
        },
      },
    }),
  );
}

function isSsmMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return (
    name === 'ParameterNotFound' ||
    name === 'ParameterNotFoundException'
  );
}

function isNotifyEmail(value: string | undefined): value is string {
  return Boolean(value && EMAIL_ADDRESS.test(value));
}

function isOwnerNotifyEventType(value: unknown): value is OwnerNotifyEventType {
  return (
    value === 'subscribed' ||
    value === 'trial_started' ||
    value === 'canceled' ||
    value === 'expired'
  );
}

function isOwnerNotifyPlatform(value: unknown): value is OwnerNotifyPlatform {
  return value === 'web' || value === 'ios' || value === 'android';
}

function isOwnerNotifyProvider(value: unknown): value is OwnerNotifyProvider {
  return value === 'stripe' || value === 'superwall';
}

function isoFromUnixSeconds(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const seconds = value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  return new Date(seconds * 1000).toISOString();
}

function unixToIso(value: unknown): string | undefined {
  return isoFromUnixSeconds(value);
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'unknown';
  return raw.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]');
}
