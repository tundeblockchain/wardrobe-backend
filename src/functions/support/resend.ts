import { logger } from '../../shared/logger';

export const RESEND_API_BASE = 'https://api.resend.com';
export const RESEND_SEND_PATH = '/emails';
export const DEFAULT_RESEND_TIMEOUT_MS = 8_000;
export const RESEND_USER_AGENT = 'wardrobe-backend/support';

export type SupportKind = 'contact' | 'bug';

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface SendEmailInput {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  idempotencyKey?: string;
}

export interface SendEmailResult {
  id?: string;
}

export interface ReceivedEmail {
  id?: string;
  from?: string;
  to?: string[];
  subject?: string;
  html?: string | null;
  text?: string | null;
  attachments?: Array<{ filename?: string | null; content_type?: string }>;
}

/**
 * Thin Resend HTTP client. Tests inject `http` — never call the live API in CI.
 */
export function createResendClient(http: FetchLike = defaultResendFetch) {
  return {
    sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
      return sendEmail(input, http);
    },
    fetchReceivedEmail(
      apiKey: string,
      emailId: string,
    ): Promise<ReceivedEmail | undefined> {
      return fetchReceivedEmail(apiKey, emailId, http);
    },
  };
}

export async function sendEmail(
  input: SendEmailInput,
  http: FetchLike = defaultResendFetch,
): Promise<SendEmailResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': RESEND_USER_AGENT,
  };
  if (input.idempotencyKey) {
    headers['Idempotency-Key'] = input.idempotencyKey;
  }

  const payload: Record<string, unknown> = {
    from: input.from,
    to: [input.to],
    subject: input.subject,
    text: input.text,
  };
  if (input.html) {
    payload.html = input.html;
  }
  if (input.replyTo) {
    payload.reply_to = input.replyTo;
  }

  const response = await http(`${RESEND_API_BASE}${RESEND_SEND_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    logger.error('Resend send failed', {
      status: response.status,
      // Do not log API keys or full provider bodies.
    });
    throw new Error(`Resend send HTTP ${response.status}`);
  }

  return parseSendResult(bodyText);
}

export async function fetchReceivedEmail(
  apiKey: string,
  emailId: string,
  http: FetchLike = defaultResendFetch,
): Promise<ReceivedEmail | undefined> {
  const response = await http(
    `${RESEND_API_BASE}/emails/receiving/${encodeURIComponent(emailId)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'User-Agent': RESEND_USER_AGENT,
      },
    },
  );

  if (!response.ok) {
    logger.warn('Resend receiving fetch failed', {
      status: response.status,
      emailId,
    });
    return undefined;
  }

  try {
    const parsed = JSON.parse(await response.text()) as ReceivedEmail;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    logger.warn('Resend receiving response was not JSON', { emailId });
    return undefined;
  }
}

export function formatOutboundMail(input: {
  kind: SupportKind;
  userId: string;
  subject: string;
  body: string;
  replyTo?: string;
  meta?: Record<string, string>;
}): { subject: string; text: string; html: string } {
  const label = input.kind === 'bug' ? 'Bug report' : 'Contact us';
  const subject = `[Wardrobe ${label}] ${input.subject}`;
  const lines = [
    `Kind: ${input.kind}`,
    `User ID: ${input.userId}`,
    input.replyTo ? `Reply-To: ${input.replyTo}` : undefined,
    '',
    input.body,
  ];

  const metaEntries = Object.entries(input.meta ?? {});
  if (metaEntries.length > 0) {
    lines.push('', '---', 'App / device');
    for (const [key, value] of metaEntries) {
      lines.push(`${key}: ${value}`);
    }
  }

  const text = lines.filter((line) => line !== undefined).join('\n');
  const html = `<pre style="font-family:ui-monospace,monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`;
  return { subject, text, html };
}

export function formatInboundForward(input: {
  webhookFrom?: string;
  webhookTo?: string[];
  webhookSubject?: string;
  email?: ReceivedEmail;
}): { subject: string; text: string; html?: string } {
  const from = input.email?.from ?? input.webhookFrom ?? '(unknown sender)';
  const to = (input.email?.to ?? input.webhookTo ?? []).join(', ') || '(unknown)';
  const originalSubject =
    input.email?.subject ?? input.webhookSubject ?? '(no subject)';
  const subject = originalSubject.toLowerCase().startsWith('fwd:')
    ? originalSubject
    : `Fwd: ${originalSubject}`;

  const attachmentNames = (input.email?.attachments ?? [])
    .map((attachment) => attachment.filename)
    .filter((name): name is string => Boolean(name && name.trim()));

  const header = [
    'Forwarded inbound mail (Resend webhook)',
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${originalSubject}`,
    attachmentNames.length
      ? `Attachments: ${attachmentNames.join(', ')}`
      : undefined,
    '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');

  const bodyText = input.email?.text?.trim();
  const bodyHtml = input.email?.html?.trim();
  const text = bodyText
    ? `${header}${bodyText}`
    : bodyHtml
      ? `${header}(HTML body; see HTML part)`
      : `${header}(Body unavailable — Resend receiving fetch failed or was empty. This is a metadata notification.)`;

  if (bodyHtml) {
    const html = `<pre style="font-family:ui-monospace,monospace;white-space:pre-wrap">${escapeHtml(header)}</pre>${bodyHtml}`;
    return { subject, text, html };
  }

  return { subject, text };
}

function parseSendResult(bodyText: string): SendEmailResult {
  if (!bodyText.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(bodyText) as { id?: unknown };
    return typeof parsed.id === 'string' ? { id: parsed.id } : {};
  } catch {
    return {};
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function defaultResendFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<{ ok: boolean; status: number; text(): Promise<string> }> {
  const timeoutMs = readTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  if (init?.signal) {
    if (init.signal.aborted) {
      controller.abort();
    } else {
      init.signal.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
    }
  }

  return fetch(url, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
  });
}

function readTimeoutMs(): number {
  const raw = process.env.RESEND_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_RESEND_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RESEND_TIMEOUT_MS;
}
