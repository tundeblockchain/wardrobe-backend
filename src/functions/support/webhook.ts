import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { Errors } from '../../shared/errors';
import { errorResponse, json } from '../../shared/http';
import { logger } from '../../shared/logger';
import { loadSupportMailConfig, SupportMailConfig } from './config';
import {
  createResendClient,
  formatInboundForward,
  ReceivedEmail,
  SendEmailInput,
  SendEmailResult,
} from './resend';
import {
  ResendWebhookHeaders,
  verifyResendWebhookSignature,
} from './webhook-verify';

export interface InboundWebhookDeps {
  loadConfig?: () => Promise<SupportMailConfig>;
  verify?: typeof verifyResendWebhookSignature;
  fetchReceivedEmail?: (
    apiKey: string,
    emailId: string,
  ) => Promise<ReceivedEmail | undefined>;
  sendEmail?: (input: SendEmailInput) => Promise<SendEmailResult>;
  nowSeconds?: number;
}

interface InboundEvent {
  type?: unknown;
  data?: {
    email_id?: unknown;
    from?: unknown;
    to?: unknown;
    subject?: unknown;
  };
}

/**
 * Public Resend inbound webhook (WARDROBE-38):
 *   POST /webhooks/resend
 *
 * Verifies Svix headers, then relays email.received to SUPPORT_FORWARD_TO.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  return handleInboundWebhook(event);
}

export async function handleInboundWebhook(
  event: APIGatewayProxyEventV2,
  deps: InboundWebhookDeps = {},
): Promise<APIGatewayProxyResultV2> {
  try {
    if (event.requestContext.http.method !== 'POST') {
      throw Errors.validation(
        `Unsupported method: ${event.requestContext.http.method}`,
      );
    }

    const payload = rawBody(event);
    const headers = svixHeaders(event);
    const config = await (deps.loadConfig ?? loadSupportMailConfig)();
    const verify = deps.verify ?? verifyResendWebhookSignature;

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
      logger.warn('Resend webhook rejected', { reason: message });
      if (message.includes('Missing')) {
        throw Errors.validation('Missing webhook signature headers.');
      }
      throw Errors.unauthorized('Invalid Resend webhook signature.');
    }

    const inbound = asInboundEvent(parsed);
    if (inbound.type !== 'email.received') {
      return json(200, {
        status: 'ignored',
        type: inbound.type ?? 'unknown',
      });
    }

    const emailId =
      typeof inbound.data?.email_id === 'string'
        ? inbound.data.email_id.trim()
        : '';
    if (!emailId) {
      throw Errors.validation('email.received is missing data.email_id.');
    }

    const client = createResendClient();
    const fetchReceived = deps.fetchReceivedEmail ?? client.fetchReceivedEmail;
    const sendEmail = deps.sendEmail ?? client.sendEmail;
    const received = await fetchReceived(config.apiKey, emailId);
    const formatted = formatInboundForward({
      webhookFrom: stringOrUndefined(inbound.data?.from),
      webhookTo: stringArray(inbound.data?.to),
      webhookSubject: stringOrUndefined(inbound.data?.subject),
      email: received,
    });

    await sendEmail({
      apiKey: config.apiKey,
      from: config.fromEmail,
      to: config.forwardTo,
      subject: formatted.subject,
      text: formatted.text,
      html: formatted.html,
      idempotencyKey: `inbound:${emailId}`,
    });

    return json(200, {
      status: 'forwarded',
      emailId,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export function rawBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) {
    throw Errors.validation('Request body is required.');
  }
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, 'base64').toString('utf8');
  }
  return event.body;
}

export function svixHeaders(event: APIGatewayProxyEventV2): ResendWebhookHeaders {
  return {
    id: header(event, 'svix-id') ?? '',
    timestamp: header(event, 'svix-timestamp') ?? '',
    signature: header(event, 'svix-signature') ?? '',
  };
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

function asInboundEvent(value: unknown): InboundEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw Errors.validation('Webhook payload must be an object.');
  }
  return value as InboundEvent;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter(
    (entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()),
  );
  return items.length > 0 ? items : undefined;
}
