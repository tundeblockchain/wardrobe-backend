import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  applySuperwallEvent,
  persistEntitlement,
  resolveSuperwallUserId,
  StoredEntitlement,
  superwallEventName,
  SuperwallWebhookEvent,
} from '../../shared/entitlements';
import { getItem, keys } from '../../shared/dynamodb';
import { Errors } from '../../shared/errors';
import { errorResponse, json } from '../../shared/http';
import { logger } from '../../shared/logger';
import {
  signSvixWebhook,
  SvixWebhookHeaders,
  verifySvixWebhookSignature,
} from '../../shared/svix';
import { DynamoItem } from '../../shared/types';
import { loadSuperwallConfig, SuperwallConfig } from './config';

export interface SuperwallWebhookDeps {
  loadConfig?: () => Promise<SuperwallConfig>;
  verify?: typeof verifySvixWebhookSignature;
  loadStored?: (userId: string) => Promise<StoredEntitlement | undefined>;
  save?: (stored: StoredEntitlement) => Promise<void>;
  nowSeconds?: number;
}

/**
 * Public Superwall subscription webhook (WARDROBE-91):
 *   POST /webhooks/superwall
 *
 * Verifies Svix headers, maps the event onto USER#{uid} / ENTITLEMENT,
 * and returns 200 even when the user cannot be resolved so Superwall
 * does not retry forever. Identity is the Superwall app user id, which
 * Flutter must set to the Firebase UID.
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

    const userId = resolveSuperwallUserId(inbound.data);
    if (!userId) {
      logger.info('Superwall webhook ignored; no Firebase UID', {
        eventName,
      });
      return json(200, { status: 'ignored', reason: 'unknown_user' });
    }

    const existing = await (deps.loadStored ?? loadStoredEntitlement)(userId);
    const productId = productIdFrom(inbound);
    const { stored, skipped } = applySuperwallEvent({
      existing,
      userId,
      eventName,
      productId,
      productTiers: config.productTiers,
      store: stringOrUndefined(inbound.data?.store),
      expirationAtMs: numberOrUndefined(inbound.data?.expirationAt),
      originalTransactionId: stringOrUndefined(
        inbound.data?.originalTransactionId,
      ),
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

async function loadStoredEntitlement(
  userId: string,
): Promise<StoredEntitlement | undefined> {
  const row = await getItem(keys.userPk(userId), keys.entitlementSk);
  if (!row || row.entityType !== 'ENTITLEMENT') {
    return undefined;
  }
  return fromRow(row);
}

function fromRow(item: DynamoItem): StoredEntitlement {
  return {
    userId: String(item.userId),
    tier: (item.tier as StoredEntitlement['tier']) ?? 'FREE',
    status: (item.status as StoredEntitlement['status']) ?? 'NONE',
    productId:
      typeof item.productId === 'string' ? item.productId : undefined,
    store: item.store as StoredEntitlement['store'],
    period: item.period as StoredEntitlement['period'],
    expiresAt:
      typeof item.expiresAt === 'string' ? item.expiresAt : undefined,
    originalTransactionId:
      typeof item.originalTransactionId === 'string'
        ? item.originalTransactionId
        : undefined,
    lastEventId:
      typeof item.lastEventId === 'string' ? item.lastEventId : undefined,
    lastEventAt:
      typeof item.lastEventAt === 'number' ? item.lastEventAt : undefined,
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
  };
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
