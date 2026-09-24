import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import { AppError, Errors } from '../../shared/errors';
import { extractBearerToken } from '../../shared/firebase-token';
import { verifyFirebaseIdToken } from '../../shared/firebase-verify';
import {
  assertBodyWithinLimit,
  errorResponse,
  json,
  parseJsonBody,
} from '../../shared/http';
import { logger } from '../../shared/logger';
import { loadSupportMailConfig, SupportMailConfig } from './config';
import {
  allowedOriginsFromEnv,
  isOriginAllowed,
  requestOrigin,
} from './origins';
import { consumeContactRateLimit, RateLimitDecision } from './rate-limit';
import {
  createResendClient,
  formatOutboundMail,
  SendEmailInput,
  SendEmailResult,
  SupportKind,
  SupportSource,
} from './resend';
import {
  isHoneypotTripped,
  parseSupportMessage,
  parseWebsiteContact,
} from './validation';

export interface SupportHandlerDeps {
  loadConfig?: () => Promise<SupportMailConfig>;
  sendEmail?: (input: SendEmailInput) => Promise<SendEmailResult>;
  verifyIdToken?: (token: string) => Promise<string>;
  consumeRateLimit?: (sourceIp: string) => Promise<RateLimitDecision>;
}

/**
 * Support forms (WARDROBE-38 + WARDROBE-143):
 *   POST /support/contact  — Firebase token (app) or public website body
 *   POST /support/bug      — Firebase authorizer required
 *
 * Sends via Resend from SUPPORT_FROM_EMAIL to SUPPORT_FORWARD_TO.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  return handleSupport(event);
}

export async function handleSupport(
  event: APIGatewayProxyEventV2,
  deps: SupportHandlerDeps = {},
): Promise<APIGatewayProxyResultV2> {
  try {
    const method = event.requestContext.http.method;
    if (method !== 'POST') {
      throw Errors.validation(`Unsupported method: ${method}`);
    }

    const kind = resolveSupportKind(event);
    if (kind === 'contact' && !hasAuthorizationHeader(event)) {
      return await handleWebsiteContact(event, deps);
    }

    const userId =
      kind === 'contact'
        ? await requireContactUserId(event, deps)
        : getUserId(event);

    assertBodyWithinLimit(event);
    const message = parseSupportMessage(parseJsonBody(event));
    return await sendSupportMail({
      deps,
      kind,
      source: 'app',
      userId,
      subject: message.subject,
      body: message.body,
      replyTo: message.replyTo,
      meta: message.meta,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export function resolveSupportKind(event: APIGatewayProxyEventV2): SupportKind {
  const path = `${event.routeKey ?? ''} ${event.rawPath ?? ''}`.toLowerCase();
  if (path.includes('/support/bug')) {
    return 'bug';
  }
  if (path.includes('/support/contact')) {
    return 'contact';
  }
  throw Errors.validation('Unsupported support route.');
}

function hasAuthorizationHeader(event: APIGatewayProxyEventV2): boolean {
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  return typeof header === 'string' && header.trim().length > 0;
}

async function requireContactUserId(
  event: APIGatewayProxyEventV2,
  deps: SupportHandlerDeps,
): Promise<string> {
  try {
    const token = extractBearerToken(event);
    const verify = deps.verifyIdToken ?? verifyFirebaseIdToken;
    return await verify(token);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.warn('Firebase token validation failed', {
      error: error instanceof Error ? error.name : 'UnknownError',
    });
    throw Errors.invalidToken();
  }
}

async function handleWebsiteContact(
  event: APIGatewayProxyEventV2,
  deps: SupportHandlerDeps,
): Promise<APIGatewayProxyResultV2> {
  const origin = requestOrigin(event.headers);
  if (!isOriginAllowed(origin, allowedOriginsFromEnv())) {
    throw Errors.originNotAllowed();
  }

  assertBodyWithinLimit(event);
  const raw = parseJsonBody<Record<string, unknown>>(event);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Errors.validation('Request body must be an object.');
  }

  if (isHoneypotTripped(raw.company)) {
    logger.info('support.contact.honeypot', {
      metric: 'SupportContactHoneypot',
    });
    return json(202, {
      status: 'sent',
      kind: 'contact',
      source: 'website',
    });
  }

  const message = parseWebsiteContact(raw);
  // HTTP API payload v2 — only the API Gateway source IP. Never X-Forwarded-For.
  const sourceIp = event.requestContext.http.sourceIp ?? '';
  const consume = deps.consumeRateLimit ?? consumeContactRateLimit;
  const decision = await consume(sourceIp);
  if (!decision.allowed) {
    throw Errors.rateLimited(decision.retryAfterSeconds);
  }

  return await sendSupportMail({
    deps,
    kind: 'contact',
    source: 'website',
    name: message.name,
    subject: message.subject,
    body: message.message,
    replyTo: message.email,
  });
}

async function sendSupportMail(input: {
  deps: SupportHandlerDeps;
  kind: SupportKind;
  source: SupportSource;
  userId?: string;
  name?: string;
  subject: string;
  body: string;
  replyTo?: string;
  meta?: Record<string, string>;
}): Promise<APIGatewayProxyResultV2> {
  const config = await (input.deps.loadConfig ?? loadSupportMailConfig)();
  const formatted = formatOutboundMail({
    kind: input.kind,
    source: input.source,
    userId: input.userId,
    name: input.name,
    subject: input.subject,
    body: input.body,
    replyTo: input.replyTo,
    meta: input.meta,
  });

  const sendEmail = input.deps.sendEmail ?? createResendClient().sendEmail;
  const result = await sendEmail({
    apiKey: config.apiKey,
    from: config.fromEmail,
    to: config.forwardTo,
    subject: formatted.subject,
    text: formatted.text,
    html: formatted.html,
    replyTo: input.replyTo,
  });

  return json(202, {
    status: 'sent',
    kind: input.kind,
    source: input.source,
    ...(result.id ? { id: result.id } : {}),
  });
}
