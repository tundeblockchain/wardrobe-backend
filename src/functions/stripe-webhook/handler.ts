import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { Errors } from '../../shared/errors';
import { errorResponse, json } from '../../shared/http';
import { logger } from '../../shared/logger';
import {
  getStripeClient,
  getStripeConfig,
  StripeConfigDeps,
  StripeRuntimeConfig,
} from '../../shared/stripe-config';
import {
  applyStripeSubscriptionState,
  forgetStripeEvent,
  isStripeWebhookEventType,
  loadUidByStripeCustomerId,
  rawWebhookPayload,
  recordStripeEventIfNew,
  retrieveStripeSubscription,
  resolveStripeWebhookUid,
  stripeEventId,
  stripeSignatureHeader,
  StripeWebhookApplyDeps,
  StripeWebhookClient,
  subscriptionIdFromStripeEvent,
  verifyStripeWebhookSignature,
} from '../../shared/stripe-webhook';

export interface StripeWebhookHandlerDeps extends StripeWebhookApplyDeps {
  loadConfig?: () => Promise<StripeRuntimeConfig>;
  verify?: typeof verifyStripeWebhookSignature;
  getStripeClient?: () => Promise<StripeWebhookClient>;
  recordEventIfNew?: (eventId: string) => Promise<boolean>;
  forgetEvent?: (eventId: string) => Promise<void>;
  retrieveSubscription?: (
    stripe: StripeWebhookClient,
    subscriptionId: string,
  ) => Promise<Awaited<ReturnType<typeof retrieveStripeSubscription>>>;
  resolveUid?: typeof resolveStripeWebhookUid;
  loadUidByStripeCustomerId?: (
    customerId: string,
  ) => Promise<string | undefined>;
  stripeConfigDeps?: StripeConfigDeps;
}

/**
 * Public Stripe webhook (WARDROBE-190):
 *   POST /billing/stripe-webhook
 *
 * Verifies `Stripe-Signature` against the decoded raw body bytes
 * (base64-decode when `isBase64Encoded`) *before* any JSON parse.
 * Bad / missing signature → 400 and no Dynamo writes.
 *
 * Never logs the secret key, webhook secret, or signature.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  return handleStripeWebhook(event);
}

export async function handleStripeWebhook(
  event: APIGatewayProxyEventV2,
  deps: StripeWebhookHandlerDeps = {},
): Promise<APIGatewayProxyResultV2> {
  try {
    if (event.requestContext.http.method !== 'POST') {
      throw Errors.validation(
        `Unsupported method: ${event.requestContext.http.method}`,
      );
    }

    const payload = rawWebhookPayload(event);
    const signature = stripeSignatureHeader(event);
    const log = deps.log ?? logger;
    const configDeps = deps.stripeConfigDeps ?? { log };
    const loadConfig = deps.loadConfig ?? (() => getStripeConfig(configDeps));
    const verify = deps.verify ?? verifyStripeWebhookSignature;

    const config = await loadConfig();
    let stripeEvent;
    try {
      stripeEvent = verify({
        payload,
        signature,
        webhookSecret: config.webhookSecret,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Invalid webhook signature';
      log.warn('Stripe webhook rejected', { reason: message });
      throw Errors.validation(
        message.includes('Missing')
          ? 'Missing Stripe-Signature header.'
          : 'Invalid Stripe webhook signature.',
      );
    }

    const eventId = stripeEventId(stripeEvent);
    const eventType =
      typeof stripeEvent.type === 'string' ? stripeEvent.type : '';

    if (!eventId) {
      return json(200, { status: 'ignored', reason: 'missing_event_id' });
    }
    if (!isStripeWebhookEventType(eventType)) {
      return json(200, { status: 'ignored', reason: 'unhandled_event', type: eventType });
    }

    const record = deps.recordEventIfNew ?? recordStripeEventIfNew;
    const claimed = await record(eventId);
    if (!claimed) {
      return json(200, { status: 'duplicate', eventId });
    }

    try {
      const loadClient =
        deps.getStripeClient ??
        (() => getStripeClient(configDeps) as Promise<StripeWebhookClient>);
      const stripe = await loadClient();
      const subscriptionId = subscriptionIdFromStripeEvent(stripeEvent);
      if (!subscriptionId) {
        return json(200, {
          status: 'ignored',
          reason: 'missing_subscription',
          eventId,
        });
      }

      const retrieve = deps.retrieveSubscription ?? retrieveStripeSubscription;
      const subscription = await retrieve(stripe, subscriptionId);
      const resolveUid = deps.resolveUid ?? resolveStripeWebhookUid;
      const { userId } = await resolveUid({
        subscription,
        stripe,
        loadUidByStripeCustomerId:
          deps.loadUidByStripeCustomerId ?? loadUidByStripeCustomerId,
      });

      if (!userId) {
        log.warn('Stripe webhook ignored; no Firebase uid', {
          stripeSubscriptionId: subscription.id ?? subscriptionId,
        });
        return json(200, { status: 'ignored', reason: 'unknown_user', eventId });
      }

      const result = await applyStripeSubscriptionState({
        userId,
        subscription,
        lookupKeys: config.lookupKeys,
        eventId,
        eventAtMs:
          typeof stripeEvent.created === 'number'
            ? stripeEvent.created * 1000
            : undefined,
        setPaidTierStatus: deps.setPaidTierStatus,
        clearStripePaidTier: deps.clearStripePaidTier,
        persistStripeCustomerMapping: deps.persistStripeCustomerMapping,
        log,
        nowIso: deps.nowIso,
        nowMs: deps.nowMs,
      });

      return json(200, {
        status: result.status,
        reason: result.reason,
        eventId,
        ...(result.tier ? { tier: result.tier } : {}),
      });
    } catch (error) {
      const forget = deps.forgetEvent ?? forgetStripeEvent;
      await forget(eventId);
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}
