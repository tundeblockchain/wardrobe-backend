import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  applySuperwallEvent,
  bindTransactionOwner,
  GRANTING_SUPERWALL_EVENTS,
  listStoredEntitlements,
  loadTransactionOwner,
  persistEntitlement,
  pickLatestEntitlement,
  describeSuperwallIdentity,
  resolvePurchaseTarget,
  resolveSuperwallIdentity,
  StoredEntitlement,
  superwallEventName,
  SuperwallWebhookEvent,
} from '../../shared/entitlements';
import { Errors } from '../../shared/errors';
import { errorResponse, json } from '../../shared/http';
import { logger } from '../../shared/logger';
import {
  signSvixWebhook,
  SvixWebhookHeaders,
  verifySvixWebhookSignature,
} from '../../shared/svix';
import { loadSuperwallConfig, SuperwallConfig } from './config';

export interface SuperwallWebhookDeps {
  loadConfig?: () => Promise<SuperwallConfig>;
  verify?: typeof verifySvixWebhookSignature;
  loadStored?: (userId: string) => Promise<StoredEntitlement | undefined>;
  save?: (stored: StoredEntitlement) => Promise<void>;
  loadTransactionOwner?: (
    originalTransactionId: string,
  ) => Promise<string | undefined>;
  bindTransactionOwner?: (
    originalTransactionId: string,
    userId: string,
  ) => Promise<boolean>;
  nowSeconds?: number;
}

/**
 * Public Superwall subscription webhook (WARDROBE-91):
 *   POST /webhooks/superwall
 *
 * Verifies Svix headers, appends a USER#{uid} / ENTITLEMENT#{ts}#{id}
 * history row (WARDROBE-159), and returns 200 even when the user cannot
 * be resolved so Superwall does not retry forever.
 *
 * Identity (WARDROBE-167) is the single Firebase uid in
 * data.userAttributes (firebaseUid / firebase_uid, or the SDK's own
 * appUserId set by identify()). originalAppUserId is never granted. An
 * iOS device UUID or $SuperwallAlias: id is never granted.
 * A store receipt is bound to the first granted Firebase uid and is
 * not attached to a later account on the same device; a bound receipt
 * never grants its owner from an event that carries no uid.
 * There is no client confirm grant path; GET /me is read-only.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  return handleSuperwallWebhook(event);
}

export async function handleSuperwallWebhook(
  event: APIGatewayProxyEventV2,
  deps: SuperwallWebhookDeps = {},
): Promise<APIGatewayProxyResultV2> {
  try {
    if (event.requestContext.http.method !== 'POST') {
      throw Errors.validation(
        `Unsupported method: ${event.requestContext.http.method}`,
      );
    }

    const payload = rawBody(event);
    const headers = svixHeaders(event);
    const config = await (deps.loadConfig ?? loadSuperwallConfig)();
    const verify = deps.verify ?? verifySvixWebhookSignature;

    let parsed: unknown;
    try {
      parsed = verify({
        payload,
        headers,
        webhookSecret: config.webhookSecret,
        nowSeconds: deps.nowSeconds,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Invalid webhook signature';
      logger.warn('Superwall webhook rejected', { reason: message });
      if (message.includes('Missing')) {
        throw Errors.validation('Missing webhook signature headers.');
      }
      throw Errors.unauthorized('Invalid Superwall webhook signature.');
    }

    const inbound = asEvent(parsed);
    const eventName = superwallEventName(inbound);
    if (!eventName) {
      return json(200, { status: 'ignored', reason: 'missing_event_name' });
    }

    const identity = resolveSuperwallIdentity(inbound.data);
    if (identity.status !== 'ok') {
      logger.info('Superwall webhook ignored; no single Firebase UID', {
        eventName,
        reason: identity.status,
        identityFields: describeSuperwallIdentity(inbound.data),
      });
      return json(200, { status: 'ignored', reason: identity.status });
    }

    const claimedUserId = identity.userId;
    const originalTransactionId = stringOrUndefined(
      inbound.data?.originalTransactionId,
    );
    const transactionOwnerUserId = originalTransactionId
      ? await (deps.loadTransactionOwner ?? loadTransactionOwner)(
          originalTransactionId,
        )
      : undefined;
    const target = resolvePurchaseTarget({
      claimedUserId,
      transactionOwnerUserId,
      originalTransactionId,
    });

    if (target.status === 'unknown_user') {
      logger.info('Superwall webhook ignored; no Firebase UID', {
        eventName,
      });
      return json(200, { status: 'ignored', reason: 'unknown_user' });
    }

    if (target.status === 'foreign_transaction') {
      logger.info('Superwall webhook ignored; receipt owned by another user', {
        eventName,
      });
      return json(200, {
        status: 'ignored',
        reason: 'transaction_owned_by_other_user',
      });
    }

    const userId = target.userId;
    if (
      target.bindTransaction &&
      originalTransactionId &&
      GRANTING_SUPERWALL_EVENTS.has(eventName)
    ) {
      const bound = await (deps.bindTransactionOwner ?? bindTransactionOwner)(
        originalTransactionId,
        userId,
      );
      if (!bound) {
        const racedOwner = await (deps.loadTransactionOwner ??
          loadTransactionOwner)(originalTransactionId);
        if (racedOwner && racedOwner !== userId) {
          logger.info(
            'Superwall webhook ignored; receipt bound during grant race',
            { eventName },
          );
          return json(200, {
            status: 'ignored',
            reason: 'transaction_owned_by_other_user',
          });
        }
      }
    }

    const history = await loadHistory(userId, deps);
    const existing = pickLatestEntitlement(history);
    const productId = productIdFrom(inbound);
    const { stored, skipped } = applySuperwallEvent({
      existing,
      history,
      userId,
      eventName,
      productId,
      productTiers: config.productTiers,
      store: stringOrUndefined(inbound.data?.store),
      expirationAtMs: numberOrUndefined(inbound.data?.expirationAt),
      originalTransactionId,
      eventId: stringOrUndefined(inbound.data?.id),
      eventAtMs: numberOrUndefined(inbound.data?.purchasedAt),
    });

    if (!skipped) {
      await (deps.save ?? persistEntitlement)(stored);
    }

    return json(200, {
      status: skipped ? 'duplicate' : 'applied',
      eventName,
      tier: stored.tier,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export { signSvixWebhook as signSuperwallWebhook };

export function rawBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) {
    throw Errors.validation('Request body is required.');
  }
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, 'base64').toString('utf8');
  }
  return event.body;
}

export function svixHeaders(event: APIGatewayProxyEventV2): SvixWebhookHeaders {
  return {
    id: header(event, 'svix-id') ?? header(event, 'webhook-id') ?? '',
    timestamp:
      header(event, 'svix-timestamp') ?? header(event, 'webhook-timestamp') ?? '',
    signature:
      header(event, 'svix-signature') ?? header(event, 'webhook-signature') ?? '',
  };
}

async function loadHistory(
  userId: string,
  deps: SuperwallWebhookDeps,
): Promise<StoredEntitlement[]> {
  if (deps.loadStored) {
    const existing = await deps.loadStored(userId);
    return existing ? [existing] : [];
  }
  return listStoredEntitlements(userId);
}

function productIdFrom(event: SuperwallWebhookEvent): string | undefined {
  const next = stringOrUndefined(event.data?.newProductId);
  if (next) {
    return next;
  }
  return stringOrUndefined(event.data?.productId);
}

function asEvent(value: unknown): SuperwallWebhookEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw Errors.validation('Webhook payload must be an object.');
  }
  return value as SuperwallWebhookEvent;
}

function header(
  event: APIGatewayProxyEventV2,
  name: string,
): string | undefined {
  const headers = event.headers ?? {};
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
