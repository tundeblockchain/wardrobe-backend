import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { AppError } from '../../shared/errors';
import {
  assertBodyWithinLimit,
  created,
  noContent,
  ok,
  parseJsonBody,
  requirePathParam,
} from '../../shared/http';
import { logger } from '../../shared/logger';
import { createPresignedGetUrl } from '../../shared/s3';
import {
  SUPPORT_PRESIGN_EXPIRES_SECONDS,
  type SupportEmailStatus,
  type SupportFeedbackType,
  type SupportMessageAuthor,
  type SupportPlatform,
} from '../../shared/support-inbox-names';
import {
  safeAlertFailureFields,
  sendSupportInboxAlertBestEffort,
  type SupportInboxAlertDeps,
} from './alert';
import { encodeExclusiveStartKey } from './cursor';
import {
  internalErrorResponse,
  SupportNotFoundError,
  SupportUnauthorizedError,
  SupportValidationError,
  unauthorizedResponse,
  validationResponse,
  notFoundResponse,
} from './http';
import {
  deleteDeviceToken,
  isConversationOwnedBy,
  persistUserFollowUp,
  upsertDeviceToken,
  type PersistAdminReplyResult,
} from './model';
import {
  countUnreadConversationsByUid,
  listConversationsByUid,
  queryConversationMessages,
  requireConversationMeta,
  updateConversationLastReadAt,
  updateMessageEmailStatus,
  type ListConversationsByStatusResult,
} from './table';
import { conversationUnread } from './status';
import { requireSupportUser, type VerifyUserTokenFn } from './user-auth';
import { parseUserListQuery } from './user-validation';
import { parseDeviceBody, parseDeviceTokenBody, parseReplyBody } from './validation';

export type SupportInboxUserRoute =
  | 'register-device'
  | 'delete-device'
  | 'list'
  | 'thread'
  | 'follow-up';

export interface SupportInboxUserHandlerDeps {
  verifyIdToken?: VerifyUserTokenFn;
  upsertDevice?: typeof upsertDeviceToken;
  deleteDevice?: typeof deleteDeviceToken;
  listConversations?: typeof listConversationsByUid;
  countUnread?: typeof countUnreadConversationsByUid;
  requireConversation?: typeof requireConversationMeta;
  listMessages?: typeof queryConversationMessages;
  markRead?: typeof updateConversationLastReadAt;
  persistFollowUp?: typeof persistUserFollowUp;
  setMessageEmailStatus?: typeof updateMessageEmailStatus;
  presignGet?: (objectKey: string) => Promise<string>;
  alert?: SupportInboxAlertDeps;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  return handleSupportInboxUser(event);
}

export async function handleSupportInboxUser(
  event: APIGatewayProxyEventV2,
  deps: SupportInboxUserHandlerDeps = {},
): Promise<APIGatewayProxyResultV2> {
  try {
    const uid = await requireSupportUser(event, deps.verifyIdToken);
    const route = resolveSupportInboxUserRoute(event);
    switch (route) {
      case 'register-device':
        return await handleRegisterDevice(event, uid, deps);
      case 'delete-device':
        return await handleDeleteDevice(event, uid, deps);
      case 'list':
        return await handleList(event, uid, deps);
      case 'thread':
        return await handleThread(event, uid, deps);
      case 'follow-up':
        return await handleFollowUp(event, uid, deps);
    }
  } catch (error) {
    return supportInboxUserErrorResponse(error);
  }
}

export function resolveSupportInboxUserRoute(
  event: APIGatewayProxyEventV2,
): SupportInboxUserRoute {
  const method = event.requestContext.http.method.toUpperCase();
  const path = `${event.routeKey ?? ''} ${event.rawPath ?? ''}`.toLowerCase();

  if (path.includes('/support/devices') && !hasPathToken(event, path)) {
    if (method === 'POST') {
      return 'register-device';
    }
    if (method === 'DELETE') {
      return 'delete-device';
    }
  }

  if (path.includes('/support/my/conversations')) {
    if (method === 'GET') {
      if (path.includes('/messages')) {
        throw new SupportValidationError({
          path: 'unsupported user support route',
        });
      }
      if (path.includes('{id}') || hasPathConversationId(event)) {
        return 'thread';
      }
      return 'list';
    }
    if (method === 'POST' && path.includes('/messages')) {
      return 'follow-up';
    }
  }

  throw new SupportValidationError({ path: 'unsupported user support route' });
}

async function handleRegisterDevice(
  event: APIGatewayProxyEventV2,
  uid: string,
  deps: SupportInboxUserHandlerDeps,
): Promise<APIGatewayProxyResultV2> {
  assertBodyWithinLimit(event);
  const body = parseDeviceBody(parseObjectBody(event));
  const upsert = deps.upsertDevice ?? upsertDeviceToken;
  await upsert({ uid, token: body.token, platform: body.platform });
  return noContent();
}

async function handleDeleteDevice(
  event: APIGatewayProxyEventV2,
  uid: string,
  deps: SupportInboxUserHandlerDeps,
): Promise<APIGatewayProxyResultV2> {
  assertBodyWithinLimit(event);
  const { token } = parseDeviceTokenBody(parseObjectBody(event));
  const remove = deps.deleteDevice ?? deleteDeviceToken;
  await remove({ uid, token });
  return noContent();
}

async function handleList(
  event: APIGatewayProxyEventV2,
  uid: string,
  deps: SupportInboxUserHandlerDeps,
): Promise<APIGatewayProxyResultV2> {
  const query = parseUserListQuery(event.queryStringParameters);
  const list = deps.listConversations ?? listConversationsByUid;
  const countUnread = deps.countUnread ?? countUnreadConversationsByUid;
  const [result, unreadCount]: [
    ListConversationsByStatusResult,
    number,
  ] = await Promise.all([
    list({
      uid,
      limit: query.limit,
      exclusiveStartKey: query.exclusiveStartKey,
    }),
    countUnread({ uid }),
  ]);

  return ok({
    items: result.items
      .filter((item) => isConversationOwnedBy(item, uid))
      .map(mapListItem),
    unreadCount,
    nextCursor: encodeExclusiveStartKey(result.lastEvaluatedKey),
  });
}

async function handleThread(
  event: APIGatewayProxyEventV2,
  uid: string,
  deps: SupportInboxUserHandlerDeps,
): Promise<APIGatewayProxyResultV2> {
  const conversationId = requirePathParam(event, 'id');
  const requireConversation = deps.requireConversation ?? requireConversationMeta;
  const meta = await requireConversation(conversationId);
  if (!isConversationOwnedBy(meta, uid)) {
    throw new SupportNotFoundError();
  }

  const markRead = deps.markRead ?? updateConversationLastReadAt;
  await markRead({ conversationId, uid });

  const listMessages = deps.listMessages ?? queryConversationMessages;
  const messages = await listMessages(conversationId);
  const presign = deps.presignGet ?? defaultPresignGet;
  const screenshotKeyOnMeta = optionalString(meta.screenshotKey);

  const mapped = [];
  for (let index = 0; index < messages.length; index += 1) {
    mapped.push(
      await mapThreadMessage(
        messages[index],
        {
          fallbackScreenshotKey:
            index === 0 && messages[index]?.author === 'user'
              ? screenshotKeyOnMeta
              : undefined,
        },
        presign,
      ),
    );
  }

  return ok({
    conversation: mapThreadConversation(meta),
    messages: mapped,
  });
}

async function handleFollowUp(
  event: APIGatewayProxyEventV2,
  uid: string,
  deps: SupportInboxUserHandlerDeps,
): Promise<APIGatewayProxyResultV2> {
  assertBodyWithinLimit(event);
  const conversationId = requirePathParam(event, 'id');
  const { message } = parseReplyBody(parseObjectBody(event));
  const requireConversation = deps.requireConversation ?? requireConversationMeta;
  const conversation = await requireConversation(conversationId);
  if (!isConversationOwnedBy(conversation, uid)) {
    throw new SupportNotFoundError();
  }

  const persist = deps.persistFollowUp ?? persistUserFollowUp;
  const stored: PersistAdminReplyResult = await persist({
    conversationId,
    uid,
    body: message,
  });

  const type = optionalString(conversation.type) as SupportFeedbackType | undefined;
  const email = optionalString(conversation.email);
  const platform = optionalString(conversation.platform) as
    | SupportPlatform
    | undefined;
  if (type && email && platform) {
    let emailStatus: SupportEmailStatus = 'failed';
    try {
      emailStatus = await sendSupportInboxAlertBestEffort(
        {
          conversationId: stored.conversationId,
          type,
          message: stored.body,
          email,
          platform,
          appVersion: optionalString(conversation.appVersion),
          device: optionalString(conversation.device),
          uid,
          screenshotKey: optionalString(conversation.screenshotKey),
        },
        deps.alert,
      );
    } catch (error) {
      logger.error(
        'Support inbox alert failed',
        safeAlertFailureFields(stored.conversationId, error),
      );
      emailStatus = 'failed';
    }

    const setStatus = deps.setMessageEmailStatus ?? updateMessageEmailStatus;
    try {
      await setStatus({
        conversationId: stored.conversationId,
        messageSk: stored.messageSk,
        emailStatus,
        conversationLastEmailStatus: false,
      });
    } catch (error) {
      logger.error(
        'Support inbox alert failed',
        safeAlertFailureFields(stored.conversationId, error),
      );
    }
  }

  return created({
    messageId: stored.messageId,
    status: 'open' as const,
  });
}

function mapListItem(item: Record<string, unknown>): {
  conversationId: string;
  status: unknown;
  type: unknown;
  createdAt: unknown;
  lastMessageAt: unknown;
  lastMessagePreview: string;
  lastMessageAuthor: SupportMessageAuthor;
  unread: boolean;
} {
  const author = item.lastMessageAuthor;
  return {
    conversationId: String(item.conversationId ?? ''),
    status: item.status,
    type: item.type,
    createdAt: item.createdAt,
    lastMessageAt: item.lastMessageAt,
    lastMessagePreview: String(item.lastMessagePreview ?? ''),
    lastMessageAuthor: author === 'admin' ? 'admin' : 'user',
    unread: conversationUnread(item),
  };
}

function mapThreadConversation(item: Record<string, unknown>): {
  conversationId: string;
  status: unknown;
  type: unknown;
  createdAt: unknown;
  lastMessageAt: unknown;
} {
  return {
    conversationId: String(item.conversationId ?? ''),
    status: item.status,
    type: item.type,
    createdAt: item.createdAt,
    lastMessageAt: item.lastMessageAt,
  };
}

async function mapThreadMessage(
  item: Record<string, unknown>,
  options: { fallbackScreenshotKey?: string },
  presign: (objectKey: string) => Promise<string>,
): Promise<{
  messageId: string;
  author: SupportMessageAuthor;
  body: unknown;
  createdAt: unknown;
  screenshotUrl: string | null;
}> {
  const screenshotKey =
    optionalString(item.screenshotKey) ?? options.fallbackScreenshotKey;
  let screenshotUrl: string | null = null;
  if (screenshotKey) {
    try {
      screenshotUrl = await presign(screenshotKey);
    } catch (error) {
      logger.error(
        'Support inbox screenshot presign failed',
        safeAlertFailureFields(String(item.conversationId ?? ''), error),
      );
      screenshotUrl = null;
    }
  }

  return {
    messageId: String(item.messageId ?? ''),
    author: item.author === 'admin' ? 'admin' : 'user',
    body: item.body,
    createdAt: item.createdAt,
    screenshotUrl,
  };
}

async function defaultPresignGet(objectKey: string): Promise<string> {
  const result = await createPresignedGetUrl({
    objectKey,
    expiresIn: SUPPORT_PRESIGN_EXPIRES_SECONDS,
  });
  return result.imageUrl;
}

function hasPathConversationId(event: APIGatewayProxyEventV2): boolean {
  const fromParams = event.pathParameters?.id?.trim();
  if (fromParams) {
    return true;
  }
  const rawPath = event.rawPath ?? '';
  return /\/support\/my\/conversations\/[^/?]+/.test(rawPath);
}

function hasPathToken(event: APIGatewayProxyEventV2, path: string): boolean {
  if (event.pathParameters?.token?.trim()) {
    return true;
  }
  if (path.includes('{token}')) {
    return true;
  }
  const rawPath = event.rawPath ?? '';
  return /\/support\/devices\/[^/?]+/.test(rawPath);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseObjectBody(event: APIGatewayProxyEventV2): unknown {
  try {
    return parseJsonBody(event);
  } catch (error) {
    if (error instanceof AppError && error.code === 'VALIDATION_ERROR') {
      throw new SupportValidationError({
        body:
          error.message.replace(/^Request body /, '').replace(/\.$/, '') ||
          'must be valid JSON',
      });
    }
    throw error;
  }
}

function supportInboxUserErrorResponse(
  error: unknown,
): APIGatewayProxyResultV2 {
  if (error instanceof SupportValidationError) {
    return validationResponse(error.fields);
  }
  if (error instanceof SupportUnauthorizedError) {
    return unauthorizedResponse();
  }
  if (error instanceof SupportNotFoundError) {
    return notFoundResponse();
  }
  if (error instanceof AppError && error.code === 'VALIDATION_ERROR') {
    return validationResponse({ body: error.message });
  }
  logger.error('Support inbox user unhandled error', {
    error: error instanceof Error ? error.name : 'UnknownError',
  });
  return internalErrorResponse();
}
