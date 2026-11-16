import { logger } from './logger';

export const RESEND_API_BASE = 'https://api.resend.com';
export const RESEND_SEND_PATH = '/emails';
export const DEFAULT_RESEND_TIMEOUT_MS = 8_000;
export const RESEND_USER_AGENT = 'wardrobe-backend/support';

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
  /** Owner-notify passes ~3s. Support omits this and keeps the 8s default fetch. */
  timeoutMs?: number;
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
 * Thin Resend HTTP client shared by support mail (WARDROBE-38) and owner
 * notify (WARDROBE-273). Tests inject `http` — never call the live API in CI.
 *
 * 429 / 5xx / timeout / network errors throw a retryable Error. Other 4xx
 * throw PermanentResendError. Support handlers still 500; owner-notify
 * catches everything and never changes the webhook response.
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

  let response: { ok: boolean; status: number; text(): Promise<string> };
  try {
    response = await fetchWithOptionalTimeout(
      http,
      `${RESEND_API_BASE}${RESEND_SEND_PATH}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      },
      input.timeoutMs,
    );
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error('Resend send timed out');
    }
    throw error;
  }

  const bodyText = await response.text();
  if (!response.ok) {
    logger.error('Resend send failed', {
      status: response.status,
      // Do not log API keys or full provider bodies.
    });
    if (isRetryableResendStatus(response.status)) {
      throw new Error(`Resend send HTTP ${response.status}`);
    }
    throw new PermanentResendError(response.status);
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

export class PermanentResendError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Resend send HTTP ${status}`);
    this.name = 'PermanentResendError';
    this.status = status;
  }
}

function isRetryableResendStatus(status: number): boolean {
  return status === 429 || status >= 500;
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

function fetchWithOptionalTimeout(
  http: FetchLike,
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
  timeoutMs?: number,
): Promise<{ ok: boolean; status: number; text(): Promise<string> }> {
  if (!timeoutMs || timeoutMs <= 0) {
    return http(url, init);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (init.signal) {
    if (init.signal.aborted) {
      controller.abort();
    } else {
      init.signal.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
    }
  }

  const abortError = Object.assign(new Error('The operation was aborted'), {
    name: 'AbortError',
  });
  const timeout = new Promise<never>((_, reject) => {
    const onAbort = () => reject(abortError);
    if (controller.signal.aborted) {
      onAbort();
      return;
    }
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });

  return Promise.race([
    http(url, { ...init, signal: controller.signal }),
    timeout,
  ]).finally(() => {
    clearTimeout(timer);
  });
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

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}
