import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import { Errors } from '../../shared/errors';
import { errorResponse, json, parseJsonBody } from '../../shared/http';
import { loadSupportMailConfig, SupportMailConfig } from './config';
import {
  createResendClient,
  formatOutboundMail,
  SendEmailInput,
  SendEmailResult,
  SupportKind,
} from './resend';
import { parseSupportMessage } from './validation';

export interface SupportHandlerDeps {
  loadConfig?: () => Promise<SupportMailConfig>;
  sendEmail?: (input: SendEmailInput) => Promise<SendEmailResult>;
}

/**
 * Authenticated Flutter support forms (WARDROBE-38):
 *   POST /support/contact
 *   POST /support/bug
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
    const userId = getUserId(event);
    const method = event.requestContext.http.method;
    if (method !== 'POST') {
      throw Errors.validation(`Unsupported method: ${method}`);
    }

    const kind = resolveSupportKind(event);
    const message = parseSupportMessage(parseJsonBody(event));
    const config = await (deps.loadConfig ?? loadSupportMailConfig)();
    const formatted = formatOutboundMail({
      kind,
      userId,
      subject: message.subject,
      body: message.body,
      replyTo: message.replyTo,
      meta: message.meta,
    });

    const sendEmail = deps.sendEmail ?? createResendClient().sendEmail;
    const result = await sendEmail({
      apiKey: config.apiKey,
      from: config.fromEmail,
      to: config.forwardTo,
      subject: formatted.subject,
      text: formatted.text,
      html: formatted.html,
      replyTo: message.replyTo,
    });

    return json(202, {
      status: 'sent',
      kind,
      ...(result.id ? { id: result.id } : {}),
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
