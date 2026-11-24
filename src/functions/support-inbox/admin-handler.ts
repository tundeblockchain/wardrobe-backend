import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { AppError } from '../../shared/errors';
import {
  assertBodyWithinLimit,
  created,
  ok,
  parseJsonBody,
  requirePathParam,
} from '../../shared/http';
import { logger } from '../../shared/logger';
import { createPresignedGetUrl } from '../../shared/s3';
import {
  SUPPORT_PRESIGN_EXPIRES_SECONDS,
  type SupportEmailStatus,
  type SupportMessageAuthor,
} from '../../shared/support-inbox-names';
import { requireSupportAdmin, type VerifyAdminTokenFn } from './admin-auth';
import { parseAdminListQuery } from './admin-validation';
import { safeReplyFailureFields } from './alert';
import { encodeExclusiveStartKey } from './cursor';
import {
  forbiddenResponse,
  internalErrorResponse,
  notFoundResponse,
  notRetryableResponse,
  SupportForbiddenError,
  SupportNotFoundError,
  SupportNotRetryableError,
  SupportUnauthorizedError,
  SupportValidationError,
  unauthorizedResponse,
  validationResponse,
} from './http';
import {
  isLatestAdminMessage,
  isRetryableAdminEmail,
  persistAdminReply,
  persistConversationClose,
  type PersistAdminReplyResult,
} from './model';
import {
  sendSupportInboxReplyBestEffort,
  type SupportInboxReplyDeps,
} from './reply';
import {
  claimFailedAdminEmailRetry,
  listConversationsByStatus,
  queryConversationMessages,
  requireConversationMessage,
  requireConversationMeta,
  updateMessageEmailStatus,
  type ListConversationsByStatusResult,
} from './table';
import { parseReplyBody } from './validation';

export type SupportInboxAdminRoute =
  | 'list'
  | 'thread'
  | 'reply'
  | 'close'
  | 'retry';

export interface SupportInboxAdminHandlerDeps {
  verifyIdToken?: VerifyAdminTokenFn;
  listConversations?: typeof listConversationsByStatus;
  requireConversation?: typeof requireConversationMeta;
  listMessages?: typeof queryConversationMessages;
  persistReply?: typeof persistAdminReply;
  persistClose?: typeof persistConversationClose;
  requireMessage?: typeof requireConversationMessage;
  claimRetry?: typeof claimFailedAdminEmailRetry;
  setMessageEmailStatus?: typeof updateMessageEmailStatus;
  presignGet?: (objectKey: string) => Promise<string>;
  reply?: SupportInboxReplyDeps;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  return handleSupportInboxAdmin(event);
}

export async function handleSupportInboxAdmin(
  event: APIGatewayProxyEventV2,
  deps: SupportInboxAdminHandlerDeps = {},
): Promise<APIGatewayProxyResultV2> {
  try {
    // Claim check in Lambda for every admin route (not only API Gateway).
    await requireSupportAdmin(event, deps.verifyIdToken);
    const route = resolveSupportInboxAdminRoute(event);
    switch (route) {
      case 'list':
        return await handleList(event, deps);
      case 'thread':
        return await handleThread(event, deps);
      case 'reply':
        return await handleReply(event, deps);
      case 'close':
        return await handleClose(event, deps);
      case 'retry':
        return await handleRetryEmail(event, deps);
    }
  } catch (error) {
    return supportInboxAdminErrorResponse(error);
  }
}

export function resolveSupportInboxAdminRoute(
  event: APIGatewayProxyEventV2,
): SupportInboxAdminRoute {
  const method = event.requestContext.http.method.toUpperCase();
  const path = `${event.routeKey ?? ''} ${event.rawPath ?? ''}`.toLowerCase();

  if (!path.includes('/admin/support/conversations')) {
    throw new SupportValidationError({ path: 'unsupported admin support route' });
  }

  if (method === 'GET') {
    if (path.includes('{conversationid}') || hasPathConversationId(event)) {
      return 'thread';
    }
    return 'list';
  }

  if (method === 'POST') {
    if (path.includes('retry-email')) {
      return 'retry';
    }
    if (path.includes('/replies')) {
      return 'reply';
    }
    if (path.includes('/close')) {
      return 'close';
    }
  }

  throw new SupportValidationError({ path: 'unsupported admin support route' });
}

async function handleList(
  event: APIGatewayProxyEventV2,
  deps: SupportInboxAdminHandlerDeps,
): Promise<APIGatewayProxyResultV2> {
  const query = parseAdminListQuery(event.queryStringParameters);
  const list = deps.listConversations ?? listConversationsByStatus;
  const result: ListConversationsByStatusResult = await list({
    status: query.status,
    limit: query.limit,
    exclusiveStartKey: query.exclusiveStartKey,
  });

  return ok({
    items: result.items.map(mapListItem),
    nextCursor: encodeExclusiveStartKey(result.lastEvaluatedKey),
  });
}

async function handleThread(
  event: APIGatewayProxyEventV2,
  deps: SupportInboxAdminHandlerDeps,
): Promise<APIGatewayProxyResultV2> {
  const conversationId = requirePathParam(event, 'conversationId');
  const requireConversation = deps.requireConversation ?? requireConversationMeta;
  const listMessages = deps.listMessages ?? queryConversationMessages;
  const meta = await requireConversation(conversationId);
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

async function handleReply(
  event: APIGatewayProxyEventV2,
  deps: SupportInboxAdminHandlerDeps,
): Promise<APIGatewayProxyResultV2> {
  assertBodyWithinLimit(event);
  const conversationId = requirePathParam(event, 'conversationId');
  const { message } = parseReplyBody(parseObjectBody(event));
  const requireConversation = deps.requireConversation ?? requireConversationMeta;
  const conversation = await requireConversation(conversationId);
  const email = optionalString(conversation.email);
  if (!email) {
    throw new SupportNotFoundError();
  }

  const persist = deps.persistReply ?? persistAdminReply;
  const stored: PersistAdminReplyResult = await persist({
    conversationId,
    body: message,
  });

  const emailStatus = await sendReplyBestEffort(
    {
      conversationId,
      messageId: stored.messageId,
      email,
      body: stored.body,
    },
    deps,
  );

  await setStoredEmailStatus(
    {
      conversationId,
      messageId: stored.messageId,
      messageSk: stored.messageSk,
      emailStatus,
    },
    deps,
  );

  return created({
    messageId: stored.messageId,
    emailStatus,
  });
}

async function handleClose(
  event: APIGatewayProxyEventV2,
  deps: SupportInboxAdminHandlerDeps,
): Promise<APIGatewayProxyResultV2> {
  const conversationId = requirePathParam(event, 'conversationId');
  const persistClose = deps.persistClose ?? persistConversationClose;
  const closed = await persistClose(conversationId);
  return ok({
    conversationId: closed.conversationId,
    status: 'closed' as const,
  });
}

async function handleRetryEmail(
  event: APIGatewayProxyEventV2,
  deps: SupportInboxAdminHandlerDeps,
): Promise<APIGatewayProxyResultV2> {
  const conversationId = requirePathParam(event, 'conversationId');
  const messageId = requirePathParam(event, 'messageId');
  const requireMessage = deps.requireMessage ?? requireConversationMessage;
  const message = await requireMessage({ conversationId, messageId });
  if (!isRetryableAdminEmail(message)) {
    throw new SupportNotRetryableError();
  }

  const requireConversation = deps.requireConversation ?? requireConversationMeta;
  const conversation = await requireConversation(conversationId);
  const email = optionalString(conversation.email);
  if (!email) {
    throw new SupportNotFoundError();
  }

  const claim = deps.claimRetry ?? claimFailedAdminEmailRetry;
  await claim({
    conversationId,
    messageSk: String(message.SK),
  });

  const body = optionalString(message.body) ?? '';
  const emailStatus = await sendReplyBestEffort(
    {
      conversationId,
      messageId,
      email,
      body,
    },
    deps,
  );

  await setStoredEmailStatus(
    {
      conversationId,
      messageId,
      messageSk: String(message.SK),
      emailStatus,
      conversationLastEmailStatus: isLatestAdminMessage(conversation, message)
        ? { createdAt: optionalString(message.createdAt) ?? '' }
        : false,
    },
    deps,
  );

  return ok({
    messageId,
    emailStatus,
  });
}

async function sendReplyBestEffort(
  input: {
    conversationId: string;
    messageId: string;
    email: string;
    body: string;
  },
  deps: SupportInboxAdminHandlerDeps,
): Promise<Exclude<SupportEmailStatus, 'skipped'>> {
  try {
    return await sendSupportInboxReplyBestEffort(input, deps.reply);
  } catch (error) {
    logger.error(
      'Support inbox reply failed',
      safeReplyFailureFields(input.conversationId, input.messageId, error),
    );
    return 'failed';
  }
}

async function setStoredEmailStatus(
  input: {
    conversationId: string;
    messageId: string;
    messageSk: string;
    emailStatus: SupportEmailStatus;
    conversationLastEmailStatus?: false | { createdAt: string };
  },
  deps: SupportInboxAdminHandlerDeps,
): Promise<void> {
  const setStatus = deps.setMessageEmailStatus ?? updateMessageEmailStatus;
  try {
    await setStatus({
      conversationId: input.conversationId,
      messageSk: input.messageSk,
      emailStatus: input.emailStatus,
      ...(input.conversationLastEmailStatus !== undefined
        ? { conversationLastEmailStatus: input.conversationLastEmailStatus }
        : {}),
    });
  } catch (error) {
    logger.error(
      'Support inbox reply failed',
      safeReplyFailureFields(input.conversationId, input.messageId, error),
    );
  }
}

function mapListItem(item: Record<string, unknown>): {
  conversationId: string;
  status: unknown;
  type: unknown;
  email: unknown;
  platform: unknown;
  uid: string | null;
  createdAt: unknown;
  lastMessageAt: unknown;
  lastMessagePreview: string;
  lastMessageAuthor: SupportMessageAuthor;
  lastEmailStatus: SupportEmailStatus | null;
} {
  const author = item.lastMessageAuthor;
  return {
    conversationId: String(item.conversationId ?? ''),
    status: item.status,
    type: item.type,
    email: item.email,
    platform: item.platform,
    uid: optionalString(item.uid) ?? null,
    createdAt: item.createdAt,
    lastMessageAt: item.lastMessageAt,
    lastMessagePreview: String(item.lastMessagePreview ?? ''),
    lastMessageAuthor: author === 'admin' ? 'admin' : 'user',
    lastEmailStatus: optionalEmailStatus(item.lastEmailStatus),
  };
}

function mapThreadConversation(item: Record<string, unknown>): {
  conversationId: string;
  status: unknown;
  type: unknown;
  email: unknown;
  platform: unknown;
  uid: string | null;
  appVersion: string | null;
  device: string | null;
  createdAt: unknown;
  lastMessageAt: unknown;
} {
  return {
    conversationId: String(item.conversationId ?? ''),
    status: item.status,
    type: item.type,
    email: item.email,
    platform: item.platform,
    uid: optionalString(item.uid) ?? null,
    appVersion: optionalString(item.appVersion) ?? null,
    device: optionalString(item.device) ?? null,
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
  emailStatus: SupportEmailStatus | null;
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
        safeReplyFailureFields(
          String(item.conversationId ?? ''),
          String(item.messageId ?? ''),
          error,
        ),
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
    emailStatus: optionalEmailStatus(item.emailStatus),
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
  const fromParams = event.pathParameters?.conversationId?.trim();
  if (fromParams) {
    return true;
  }
  const rawPath = event.rawPath ?? '';
  return /\/admin\/support\/conversations\/[^/?]+/.test(rawPath);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalEmailStatus(value: unknown): SupportEmailStatus | null {
  if (value === 'sent' || value === 'failed' || value === 'skipped') {
    return value;
  }
  return null;
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

function supportInboxAdminErrorResponse(
  error: unknown,
): APIGatewayProxyResultV2 {
  if (error instanceof SupportValidationError) {
    return validationResponse(error.fields);
  }
  if (error instanceof SupportUnauthorizedError) {
    return unauthorizedResponse();
  }
  if (error instanceof SupportForbiddenError) {
    return forbiddenResponse();
  }
  if (error instanceof SupportNotFoundError) {
    return notFoundResponse();
  }
  if (error instanceof SupportNotRetryableError) {
    return notRetryableResponse();
  }
  if (error instanceof AppError && error.code === 'VALIDATION_ERROR') {
    return validationResponse({ body: error.message });
  }
  logger.error('Support inbox admin unhandled error', {
    error: error instanceof Error ? error.name : 'UnknownError',
  });
  return internalErrorResponse();
}
