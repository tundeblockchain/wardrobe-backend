import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import {
  deleteItem,
  getItem,
  keys,
  putItem,
  queryByPk,
  updateAttributes,
} from '../../shared/dynamodb';
import { AppError, Errors } from '../../shared/errors';
import {
  errorResponse,
  noContent,
  ok,
  parseJsonBody,
  requirePathParam,
  routeKey,
} from '../../shared/http';
import { nowIso } from '../../shared/ids';
import {
  DEFAULT_JOB_EVENT_LIMIT,
  Device,
  DynamoItem,
  JobEvent,
  JobEventAckResponse,
  JobEventList,
  MAX_JOB_EVENT_LIMIT,
} from '../../shared/types';
import {
  optionalQueryBoolean,
  optionalQueryString,
  requireNonEmptyString,
} from '../../shared/validation';
import { deviceIdFromToken } from './ids';
import {
  isDevicePlatform,
  isOwnedDevice,
  isOwnedJobEvent,
  isUnreadJobEvent,
  toDeviceDto,
  toJobEventDto,
} from './model';

interface RegisterDeviceBody {
  token?: unknown;
  platform?: unknown;
  deviceId?: unknown;
}

interface AckEventsBody {
  eventIds?: unknown;
}

/**
 * Owner-only job-done inbox + FCM device registration (WARDROBE-114).
 *
 * GET    /me/events                     — list events (default unread)
 * POST   /me/events/{eventId}/ack       — ack one (idempotent)
 * POST   /me/events/ack                 — ack many (skips unknown ids)
 * PUT    /me/devices                    — upsert FCM token
 * DELETE /me/devices/{deviceId}         — unregister (204 if already gone)
 *
 * Identity always comes from the Firebase authorizer (`getUserId`).
 * Body / query `userId` is ignored.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = getUserId(event);
    const method = event.requestContext.http.method;
    const key = routeKey(event);
    const path = event.rawPath;

    if (method === 'GET' && isEventsCollection(key, path)) {
      return ok(await listEvents(userId, event.queryStringParameters));
    }

    if (method === 'POST' && isBulkAck(key, path)) {
      return ok(await ackEvents(userId, parseAckIds(event)));
    }

    if (method === 'POST' && isSingleAck(key, path)) {
      const eventId = requirePathParam(event, 'eventId');
      return ok(await ackEvent(userId, eventId));
    }

    if (method === 'PUT' && isDevicesCollection(key, path)) {
      return ok(await registerDevice(userId, parseJsonBody<RegisterDeviceBody>(event)));
    }

    if (method === 'DELETE' && isDeviceItem(key, path)) {
      await unregisterDevice(userId, requirePathParam(event, 'deviceId'));
      return noContent();
    }

    throw Errors.validation(`Unsupported route: ${key}`);
  } catch (error) {
    return errorResponse(error);
  }
}

async function listEvents(
  userId: string,
  query: APIGatewayProxyEventV2['queryStringParameters'],
): Promise<JobEventList> {
  const unreadOnly = optionalQueryBoolean(query?.unreadOnly, 'unreadOnly') ?? true;
  const limit = parseLimit(optionalQueryString(query?.limit, 'limit'));

  const rows = (await queryByPk(keys.userPk(userId), keys.eventSkPrefix))
    .filter((item) => isOwnedJobEvent(item, userId))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));

  const unread = rows.filter(isUnreadJobEvent);
  const source = unreadOnly ? unread : rows;

  return {
    events: source.slice(0, limit).map(toJobEventDto),
    unreadCount: unread.length,
  };
}

async function ackEvent(userId: string, rawEventId: string): Promise<JobEvent> {
  const eventId = requireNonEmptyString(rawEventId, 'eventId', 160);
  const existing = await getItem(keys.userPk(userId), keys.eventSk(eventId));
  if (!isOwnedJobEvent(existing, userId)) {
    throw Errors.eventNotFound();
  }
  if (!isUnreadJobEvent(existing)) {
    return toJobEventDto(existing);
  }

  const updated = await updateAttributes(
    keys.userPk(userId),
    keys.eventSk(eventId),
    {
      acknowledgedAt: nowIso(),
      updatedAt: nowIso(),
    },
  );
  return toJobEventDto(updated);
}

async function ackEvents(
  userId: string,
  eventIds: string[],
): Promise<JobEventAckResponse> {
  const events: JobEvent[] = [];
  const seen = new Set<string>();
  for (const eventId of eventIds) {
    if (seen.has(eventId)) {
      continue;
    }
    seen.add(eventId);
    try {
      events.push(await ackEvent(userId, eventId));
    } catch (error) {
      if (error instanceof AppError && error.code === 'EVENT_NOT_FOUND') {
        continue;
      }
      throw error;
    }
  }
  return { events };
}

async function registerDevice(
  userId: string,
  body: RegisterDeviceBody,
): Promise<Device> {
  const token = requireNonEmptyString(body.token, 'token', 4096);
  if (!isDevicePlatform(body.platform)) {
    throw Errors.validation('platform must be IOS or ANDROID.');
  }
  const deviceId = body.deviceId
    ? requireDeviceId(body.deviceId)
    : deviceIdFromToken(token);
  const timestamp = nowIso();
  const existing = await getItem(keys.userPk(userId), keys.deviceSk(deviceId));
  const createdAt =
    isOwnedDevice(existing, userId) && typeof existing.createdAt === 'string'
      ? existing.createdAt
      : timestamp;

  const item: DynamoItem = {
    PK: keys.userPk(userId),
    SK: keys.deviceSk(deviceId),
    entityType: 'DEVICE',
    userId,
    deviceId,
    platform: body.platform,
    token,
    createdAt,
    updatedAt: timestamp,
  };
  await putItem(item);
  return toDeviceDto(item);
}

async function unregisterDevice(userId: string, rawDeviceId: string): Promise<void> {
  const deviceId = requireDeviceId(rawDeviceId);
  const existing = await getItem(keys.userPk(userId), keys.deviceSk(deviceId));
  if (!isOwnedDevice(existing, userId)) {
    return;
  }
  await deleteItem(keys.userPk(userId), keys.deviceSk(deviceId));
}

function parseAckIds(event: APIGatewayProxyEventV2): string[] {
  const body = parseJsonBody<AckEventsBody>(event);
  if (!Array.isArray(body.eventIds) || body.eventIds.length === 0) {
    throw Errors.validation('eventIds must be a non-empty array.');
  }
  if (body.eventIds.length > MAX_JOB_EVENT_LIMIT) {
    throw Errors.validation(
      `eventIds must contain ${MAX_JOB_EVENT_LIMIT} or fewer ids.`,
    );
  }
  return body.eventIds.map((value, index) =>
    requireNonEmptyString(value, `eventIds[${index}]`, 160),
  );
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_JOB_EVENT_LIMIT;
  }
  if (!/^\d+$/.test(raw)) {
    throw Errors.validation('limit must be an integer.');
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_JOB_EVENT_LIMIT) {
    throw Errors.validation(`limit must be between 1 and ${MAX_JOB_EVENT_LIMIT}.`);
  }
  return value;
}

function requireDeviceId(value: unknown): string {
  const deviceId = requireNonEmptyString(value, 'deviceId', 64);
  if (!/^[A-Za-z0-9_-]+$/.test(deviceId)) {
    throw Errors.validation(
      'deviceId must be letters, numbers, underscore, or hyphen.',
    );
  }
  return deviceId;
}

function isEventsCollection(key: string, rawPath: string): boolean {
  return key === 'GET /me/events' || rawPath === '/me/events' || rawPath.endsWith('/me/events');
}

function isBulkAck(key: string, rawPath: string): boolean {
  return (
    key === 'POST /me/events/ack' ||
    rawPath === '/me/events/ack' ||
    rawPath.endsWith('/me/events/ack')
  );
}

function isSingleAck(key: string, rawPath: string): boolean {
  return (
    key === 'POST /me/events/{eventId}/ack' ||
    /\/me\/events\/[^/]+\/ack$/.test(rawPath)
  );
}

function isDevicesCollection(key: string, rawPath: string): boolean {
  return (
    key === 'PUT /me/devices' ||
    rawPath === '/me/devices' ||
    rawPath.endsWith('/me/devices')
  );
}

function isDeviceItem(key: string, rawPath: string): boolean {
  return (
    key === 'DELETE /me/devices/{deviceId}' ||
    /\/me\/devices\/[^/]+$/.test(rawPath)
  );
}
