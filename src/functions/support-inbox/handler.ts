import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { AppError } from '../../shared/errors';
import { extractBearerToken } from '../../shared/firebase-token';
import { verifyFirebaseIdToken } from '../../shared/firebase-verify';
import {
  assertBodyWithinLimit,
  created,
  ok,
  parseJsonBody,
} from '../../shared/http';
import { logger } from '../../shared/logger';
import type { SupportEmailStatus } from '../../shared/support-inbox-names';
import {
  safeAlertFailureFields,
  sendSupportInboxAlertBestEffort,
  type SupportInboxAlertDeps,
} from './alert';
import {
  internalErrorResponse,
  rateLimitedResponse,
  SupportRateLimitError,
  SupportUnauthenticatedError,
  SupportValidationError,
  unauthenticatedResponse,
  validationResponse,
} from './http';
import {
  newConversationId,
  persistConversation,
  type PersistConversationResult,
} from './model';
import { updateMessageEmailStatus } from './table';
import { createSupportUploadPost } from './presign';
import {
  assertAllowed,
  consumeFeedbackRateLimit,
  consumeUploadIpRateLimit,
  type RateLimitDecision,
} from './rate-limit';
import { assertSupportScreenshot, type HeadScreenshotFn } from './screenshot';
import { parseFeedbackBody, parseUploadUrlBody } from './validation';

export interface SupportInboxHandlerDeps {
  persistConversation?: typeof persistConversation;
  setMessageEmailStatus?: typeof updateMessageEmailStatus;
  createUploadPost?: typeof createSupportUploadPost;
  headScreenshot?: HeadScreenshotFn;
  verifyIdToken?: (token: string) => Promise<string>;
  consumeUploadRateLimit?: (sourceIp: string) => Promise<RateLimitDecision>;
  consumeFeedbackRateLimit?: (
    sourceIp: string,
    email: string,
  ) => Promise<RateLimitDecision>;
  newConversationId?: () => string;
  alert?: SupportInboxAlertDeps;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  return handleSupportInbox(event);
}

export async function handleSupportInbox(
  event: APIGatewayProxyEventV2,
  deps: SupportInboxHandlerDeps = {},
): Promise<APIGatewayProxyResultV2> {
  try {
    const method = event.requestContext.http.method;
    if (method !== 'POST') {
      throw new SupportValidationError({ method: 'must be POST' });
    }

    const route = resolveSupportInboxRoute(event);
    if (route === 'upload-url') {
      return await handleUploadUrl(event, deps);
    }
    return await handleFeedback(event, deps);
  } catch (error) {
    return supportInboxErrorResponse(error);
  }
}

export function resolveSupportInboxRoute(
  event: APIGatewayProxyEventV2,
): 'upload-url' | 'feedback' {
  const path = `${event.routeKey ?? ''} ${event.rawPath ?? ''}`.toLowerCase();
  if (path.includes('/support/upload-url')) {
    return 'upload-url';
  }
  if (path.includes('/support/feedback')) {
    return 'feedback';
  }
  throw new SupportValidationError({ path: 'unsupported support inbox route' });
}

async function handleUploadUrl(
  event: APIGatewayProxyEventV2,
  deps: SupportInboxHandlerDeps,
): Promise<APIGatewayProxyResultV2> {
  assertBodyWithinLimit(event);
  const { contentType } = parseUploadUrlBody(parseObjectBody(event));
  const sourceIp = event.requestContext.http.sourceIp ?? '';
  const consume = deps.consumeUploadRateLimit ?? consumeUploadIpRateLimit;
  assertAllowed(await consume(sourceIp));

  const createPost = deps.createUploadPost ?? createSupportUploadPost;
  const result = await createPost({ contentType });
  return ok({
    url: result.url,
    fields: result.fields,
    screenshotKey: result.screenshotKey,
  });
}

async function handleFeedback(
  event: APIGatewayProxyEventV2,
  deps: SupportInboxHandlerDeps,
): Promise<APIGatewayProxyResultV2> {
  assertBodyWithinLimit(event);
  const parsed = parseFeedbackBody(parseObjectBody(event));
  const conversationId = (deps.newConversationId ?? newConversationId)();

  if (parsed.honeypot) {
    logger.info('support.inbox.honeypot', {
      metric: 'SupportInboxHoneypot',
    });
    return created({ conversationId });
  }

  const uid = await optionalUid(event, deps);
  const sourceIp = event.requestContext.http.sourceIp ?? '';
  const consume = deps.consumeFeedbackRateLimit ?? consumeFeedbackRateLimit;
  assertAllowed(await consume(sourceIp, parsed.value.email));

  if (parsed.value.screenshotKey) {
    await assertSupportScreenshot(parsed.value.screenshotKey, deps.headScreenshot);
  }

  const persist = deps.persistConversation ?? persistConversation;
  const stored: PersistConversationResult = await persist({
    ...parsed.value,
    conversationId,
    uid,
  });

  let emailStatus: SupportEmailStatus = 'failed';
  try {
    emailStatus = await sendSupportInboxAlertBestEffort(
      {
        conversationId: stored.conversationId,
        type: parsed.value.type,
        message: parsed.value.message,
        email: parsed.value.email,
        platform: parsed.value.platform,
        appVersion: parsed.value.appVersion,
        device: parsed.value.device,
        uid,
        screenshotKey: parsed.value.screenshotKey,
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
    });
  } catch (error) {
    logger.error(
      'Support inbox alert failed',
      safeAlertFailureFields(stored.conversationId, error),
    );
  }

  return created({ conversationId: stored.conversationId });
}

async function optionalUid(
  event: APIGatewayProxyEventV2,
  deps: SupportInboxHandlerDeps,
): Promise<string | undefined> {
  if (!hasAuthorizationHeader(event)) {
    return undefined;
  }
  try {
    const token = extractBearerToken(event);
    const verify = deps.verifyIdToken ?? verifyFirebaseIdToken;
    return await verify(token);
  } catch {
    throw new SupportUnauthenticatedError();
  }
}

function hasAuthorizationHeader(event: APIGatewayProxyEventV2): boolean {
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  return typeof header === 'string' && header.trim().length > 0;
}

function parseObjectBody(event: APIGatewayProxyEventV2): unknown {
  try {
    return parseJsonBody(event);
  } catch (error) {
    if (error instanceof AppError && error.code === 'VALIDATION_ERROR') {
      throw new SupportValidationError({
        body: error.message.replace(/^Request body /, '').replace(/\.$/, '') ||
          'must be valid JSON',
      });
    }
    throw error;
  }
}

function supportInboxErrorResponse(error: unknown): APIGatewayProxyResultV2 {
  if (error instanceof SupportValidationError) {
    return validationResponse(error.fields);
  }
  if (error instanceof SupportRateLimitError) {
    return rateLimitedResponse(error.retryAfterSeconds);
  }
  if (error instanceof SupportUnauthenticatedError) {
    return unauthenticatedResponse();
  }
  if (error instanceof AppError && error.code === 'VALIDATION_ERROR') {
    return validationResponse({ body: error.message });
  }
  logger.error('Support inbox unhandled error', {
    error: error instanceof Error ? error.name : 'UnknownError',
  });
  return internalErrorResponse();
}
