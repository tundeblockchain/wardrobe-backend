import { logger } from '../../shared/logger';
import { sendEmail, type FetchLike } from '../../shared/resend';
import {
  SUPPORT_FROM_EMAIL_ENV,
  SUPPORT_INBOX_APP_LINK_ENV,
  SUPPORT_INBOX_APP_LINK_PARAM_ENV,
  readSupportEmailTimeoutMs,
  type SupportEmailStatus,
} from '../../shared/support-inbox-names';
import {
  getSsmParameter,
  loadSupportInboxApiKey,
  loadSupportInboxRecipient,
  safeReplyFailureFields,
  type SupportInboxAlertDeps,
} from './alert';

export interface SupportInboxReply {
  conversationId: string;
  messageId: string;
  email: string;
  body: string;
}

export interface SupportInboxReplyDeps extends SupportInboxAlertDeps {
  loadAppLink?: () => Promise<string | undefined>;
  sendReply?: (reply: SupportInboxReply) => Promise<void>;
}

const APP_LINK_LABEL = 'Open in Pocket Closet';

/**
 * Best-effort admin reply email. Never throws. Timeout is
 * SUPPORT_EMAIL_TIMEOUT_MS. DynamoDB write happens first in the handler;
 * this runs only after that write succeeds.
 */
export async function sendSupportInboxReplyBestEffort(
  reply: SupportInboxReply,
  deps: SupportInboxReplyDeps = {},
): Promise<Exclude<SupportEmailStatus, 'skipped'>> {
  const log = deps.log ?? logger;
  try {
    if (deps.sendReply) {
      await deps.sendReply(reply);
      return 'sent';
    }
    const status = await sendSupportInboxReply(reply, deps);
    return status === 'skipped' ? 'failed' : status;
  } catch (error) {
    log.error(
      'Support inbox reply failed',
      safeReplyFailureFields(reply.conversationId, reply.messageId, error),
    );
    return 'failed';
  }
}

export async function sendSupportInboxReply(
  reply: SupportInboxReply,
  deps: SupportInboxReplyDeps = {},
): Promise<SupportEmailStatus> {
  const log = deps.log ?? logger;
  const env = deps.env ?? process.env;
  const sender = env[SUPPORT_FROM_EMAIL_ENV]?.trim();
  if (!sender) {
    log.error(
      'Support inbox reply failed',
      safeReplyFailureFields(
        reply.conversationId,
        reply.messageId,
        'SenderMissing',
      ),
    );
    return 'failed';
  }

  const loadApiKey =
    deps.loadApiKey ??
    (() =>
      loadSupportInboxApiKey({
        env,
        getSecret: deps.getSecret,
        log,
      }));
  const apiKey = await loadApiKey();
  if (!apiKey) {
    log.error(
      'Support inbox reply failed',
      safeReplyFailureFields(
        reply.conversationId,
        reply.messageId,
        'ApiKeyMissing',
      ),
    );
    return 'failed';
  }

  const replyTo = await loadSupportInboxRecipient({
    env,
    getParameter: deps.getParameter,
    log,
  });
  const loadAppLink = deps.loadAppLink ?? (() => loadSupportInboxAppLink(deps));
  const appLink = await loadAppLink();
  const formatted = formatSupportInboxReply(reply.body, appLink);
  const timeoutMs = deps.timeoutMs ?? readSupportEmailTimeoutMs(env);

  await sendEmail(
    {
      apiKey,
      from: sender,
      to: reply.email,
      subject: 'Pocket Closet support reply',
      text: formatted.text,
      html: formatted.html,
      ...(replyTo ? { replyTo } : {}),
      timeoutMs,
    },
    deps.http,
  );

  log.info('Support inbox reply sent', {
    conversationId: reply.conversationId,
    messageId: reply.messageId,
    hasAppLink: Boolean(appLink),
    hasReplyTo: Boolean(replyTo),
  });
  return 'sent';
}

export function formatSupportInboxReply(
  body: string,
  appLink?: string,
): { text: string; html: string } {
  const textLines = [body];
  if (appLink) {
    textLines.push('', `${APP_LINK_LABEL}:`, appLink);
  }

  const htmlParts = [
    `<p>${escapeHtml(body).replace(/\r\n|\r|\n/g, '<br>')}</p>`,
  ];
  if (appLink) {
    const href = escapeHtml(appLink);
    htmlParts.push(`<p><a href="${href}">${APP_LINK_LABEL}</a></p>`);
  }

  return {
    text: textLines.join('\n'),
    html: htmlParts.join('\n'),
  };
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function loadSupportInboxAppLink(
  deps: SupportInboxReplyDeps = {},
): Promise<string | undefined> {
  const env = deps.env ?? process.env;
  const fromEnv = optionalHttpUrl(env[SUPPORT_INBOX_APP_LINK_ENV]);
  if (fromEnv) {
    return fromEnv;
  }
  const paramName = env[SUPPORT_INBOX_APP_LINK_PARAM_ENV]?.trim();
  if (!paramName) {
    return undefined;
  }
  const getParameter = deps.getParameter ?? getSsmParameter;
  try {
    return optionalHttpUrl(await getParameter(paramName));
  } catch {
    return undefined;
  }
}

function optionalHttpUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return undefined;
    }
    return trimmed;
  } catch {
    return undefined;
  }
}
