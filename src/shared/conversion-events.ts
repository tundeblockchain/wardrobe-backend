import { createHash } from 'crypto';
import { SuperwallWebhookEvent } from './entitlements';
import { StripeSubscriptionLike } from './stripe-webhook';

export const CONVERSION_EVENT_SUBSCRIBE = 'Subscribe';
export const CONVERSION_EVENT_START_TRIAL = 'StartTrial';
export const CONVERSION_EVENT_RENEWED = 'SubscriptionRenewed';

export type ConversionEventName =
  | typeof CONVERSION_EVENT_SUBSCRIBE
  | typeof CONVERSION_EVENT_START_TRIAL
  | typeof CONVERSION_EVENT_RENEWED;

export type ConversionActionSource = 'website' | 'app';

export interface ConversionEvent {
  eventName: ConversionEventName;
  eventId: string;
  eventTimeSeconds: number;
  actionSource: ConversionActionSource;
  /** SHA-256 hex of the Firebase uid. Never the raw uid. */
  externalId: string;
  value?: number;
  currency?: string;
}

export const SUPERWALL_CONVERSION_SKIP_EVENTS = new Set([
  'cancellation',
  'uncancellation',
  'expiration',
  'billing_issue',
  'subscription_paused',
  'product_change',
  'non_renewing_purchase',
  'refund',
  'restore',
]);

const STRIPE_ZERO_DECIMAL = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'ugx',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
]);

export function hashExternalId(userId: string): string {
  return createHash('sha256').update(userId.trim(), 'utf8').digest('hex');
}

export function stripeCheckoutEventId(checkoutSessionId: string): string {
  return `stripe_${checkoutSessionId.trim()}`;
}

export function stripeInvoiceEventId(invoiceId: string): string {
  return `stripe_${invoiceId.trim()}`;
}

export function superwallConversionEventId(transactionId: string): string {
  return `sw_${transactionId.trim()}`;
}

export function isStripeTrialSubscription(
  subscription: StripeSubscriptionLike | undefined,
  eventTimeSeconds?: number,
): boolean {
  if (!subscription) {
    return false;
  }
  const status = optionalString(subscription.status)?.toLowerCase();
  if (status === 'trialing') {
    return true;
  }
  const trialEnd = unixSeconds(subscription.trial_end);
  if (trialEnd === undefined) {
    return false;
  }
  const now =
    typeof eventTimeSeconds === 'number' && Number.isFinite(eventTimeSeconds)
      ? eventTimeSeconds
      : Math.floor(Date.now() / 1000);
  return trialEnd > now;
}

export function stripeMinorToMajor(
  amount: number,
  currency: string | undefined,
): number {
  const code = optionalString(currency)?.toLowerCase() ?? '';
  if (STRIPE_ZERO_DECIMAL.has(code)) {
    return amount;
  }
  return amount / 100;
}

/**
 * Map a verified Stripe webhook to a conversion event.
 *
 * Subscribe / StartTrial: `checkout.session.completed` (`stripe_<checkoutSessionId>`).
 * Renewal: `invoice.paid` with `billing_reason=subscription_cycle` (`stripe_<invoiceId>`).
 * Other types, refunds, and missing ids return undefined.
 */
export function mapStripeConversionEvent(options: {
  type: string;
  object: Record<string, unknown> | undefined;
  userId: string | undefined;
  subscription?: StripeSubscriptionLike;
  eventTimeSeconds?: number;
}): ConversionEvent | undefined {
  const userId = optionalString(options.userId);
  const object = options.object;
  if (!userId || !object) {
    return undefined;
  }

  const eventTimeSeconds = unixSeconds(options.eventTimeSeconds) ??
    unixSeconds(object.created) ??
    Math.floor(Date.now() / 1000);

  if (options.type === 'checkout.session.completed') {
    const sessionId = optionalString(object.id);
    if (!sessionId) {
      return undefined;
    }
    const trial = isStripeTrialSubscription(
      options.subscription,
      eventTimeSeconds,
    );
    return buildConversionEvent({
      eventName: trial ? CONVERSION_EVENT_START_TRIAL : CONVERSION_EVENT_SUBSCRIBE,
      eventId: stripeCheckoutEventId(sessionId),
      eventTimeSeconds,
      actionSource: 'website',
      userId,
      value: stripeMoney(object.amount_total, object.currency),
      currency: optionalString(object.currency)?.toUpperCase(),
    });
  }

  if (options.type === 'invoice.paid') {
    const billingReason = optionalString(object.billing_reason)?.toLowerCase();
    if (billingReason !== 'subscription_cycle') {
      return undefined;
    }
    const invoiceId = optionalString(object.id);
    if (!invoiceId) {
      return undefined;
    }
    return buildConversionEvent({
      eventName: CONVERSION_EVENT_RENEWED,
      eventId: stripeInvoiceEventId(invoiceId),
      eventTimeSeconds,
      actionSource: 'website',
      userId,
      value: stripeMoney(object.amount_paid, object.currency),
      currency: optionalString(object.currency)?.toUpperCase(),
    });
  }

  return undefined;
}

export function stripeObjectCustomerId(
  object: Record<string, unknown> | undefined,
): string | undefined {
  if (!object) {
    return undefined;
  }
  return idOf(object.customer);
}

export function stripeObjectUid(
  object: Record<string, unknown> | undefined,
): string | undefined {
  if (!object) {
    return undefined;
  }
  const metadata = asRecord(object.metadata);
  const fromMetadata = optionalString(metadata?.uid);
  if (fromMetadata) {
    return fromMetadata;
  }
  return optionalString(object.client_reference_id);
}

/**
 * Map a verified Superwall webhook to a conversion event.
 *
 * initial_purchase → Subscribe or StartTrial (periodType TRIAL / INTRO).
 * renewal → SubscriptionRenewed.
 * Restores, refunds, cancellations, and other events return undefined.
 * event_id is `sw_<transactionId>` (store transaction id; unique per purchase
 * and per renewal). Never generated randomly.
 */
export function mapSuperwallConversionEvent(
  event: SuperwallWebhookEvent,
  userId: string | undefined,
  nowSeconds?: number,
): ConversionEvent | undefined {
  const uid = optionalString(userId);
  if (!uid) {
    return undefined;
  }

  const name = superwallName(event);
  if (!name || SUPERWALL_CONVERSION_SKIP_EVENTS.has(name)) {
    return undefined;
  }

  const data = event.data;
  const transactionId =
    idOf((data as { transactionId?: unknown } | undefined)?.transactionId) ??
    idOf((data as { transaction_id?: unknown } | undefined)?.transaction_id);
  if (!transactionId) {
    return undefined;
  }

  const eventTimeSeconds =
    toUnixSeconds(
      (data as { purchasedAt?: unknown } | undefined)?.purchasedAt ??
        (data as { ts?: unknown } | undefined)?.ts,
    ) ??
    (typeof nowSeconds === 'number' && Number.isFinite(nowSeconds)
      ? nowSeconds
      : Math.floor(Date.now() / 1000));

  const money = superwallMoney(data);
  const base = {
    eventId: superwallConversionEventId(transactionId),
    eventTimeSeconds,
    actionSource: 'app' as const,
    userId: uid,
    value: money.value,
    currency: money.currency,
  };

  if (name === 'renewal') {
    return buildConversionEvent({
      ...base,
      eventName: CONVERSION_EVENT_RENEWED,
    });
  }

  if (name === 'initial_purchase') {
    return buildConversionEvent({
      ...base,
      eventName: superwallIsTrialStart(data)
        ? CONVERSION_EVENT_START_TRIAL
        : CONVERSION_EVENT_SUBSCRIBE,
    });
  }

  return undefined;
}

export function superwallIsTrialStart(data: unknown): boolean {
  const record = asRecord(data);
  if (!record) {
    return false;
  }
  if (isTruthy(record.isTrialConversion) || isTruthy(record.is_trial_conversion)) {
    return false;
  }
  const period = optionalString(record.periodType ?? record.period_type)
    ?.toUpperCase()
    .replace(/-/g, '_');
  return period === 'TRIAL' || period === 'INTRO';
}

function buildConversionEvent(options: {
  eventName: ConversionEventName;
  eventId: string;
  eventTimeSeconds: number;
  actionSource: ConversionActionSource;
  userId: string;
  value?: number;
  currency?: string;
}): ConversionEvent {
  const event: ConversionEvent = {
    eventName: options.eventName,
    eventId: options.eventId,
    eventTimeSeconds: options.eventTimeSeconds,
    actionSource: options.actionSource,
    externalId: hashExternalId(options.userId),
  };
  if (typeof options.value === 'number' && Number.isFinite(options.value)) {
    event.value = options.value;
  }
  if (options.currency) {
    event.currency = options.currency;
  }
  return event;
}

function stripeMoney(
  amount: unknown,
  currency: unknown,
): number | undefined {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return undefined;
  }
  return stripeMinorToMajor(amount, optionalString(currency));
}

function superwallMoney(data: unknown): {
  value?: number;
  currency?: string;
} {
  const record = asRecord(data);
  if (!record) {
    return {};
  }
  const currency = optionalString(
    record.currencyCode ?? record.currency_code ?? record.currency,
  )?.toUpperCase();
  const value = firstFiniteNumber(
    record.priceInPurchasedCurrency,
    record.price_in_purchased_currency,
    record.price,
  );
  return { value, currency };
}

function superwallName(event: SuperwallWebhookEvent): string | undefined {
  const fromData =
    typeof event.data?.name === 'string' ? event.data.name.trim().toLowerCase() : '';
  if (fromData) {
    return fromData;
  }
  return typeof event.type === 'string' && event.type.trim()
    ? event.type.trim().toLowerCase()
    : undefined;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function isTruthy(value: unknown): boolean {
  return value === true || value === 1 || value === 'true' || value === '1';
}

function toUnixSeconds(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
}

function unixSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function idOf(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return optionalString(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
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
