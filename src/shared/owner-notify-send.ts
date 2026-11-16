import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { deleteItem, keys, putItemIfNotExists } from './dynamodb';
import { nowIso } from './ids';
import { logger } from './logger';
import {
  OWNER_NOTIFY_EVENT_TTL_SECONDS,
  OWNER_NOTIFY_RECIPIENT_ENV,
  OWNER_NOTIFY_RECIPIENT_PARAM_ENV,
  OWNER_NOTIFY_RESEND_API_URL,
  OWNER_NOTIFY_RESEND_SECRET_ARN_ENV,
  OWNER_NOTIFY_RESEND_TIMEOUT_MS,
  OWNER_NOTIFY_SENDER_ENV,
  OWNER_NOTIFY_SENDER_PARAM_ENV,
} from './owner-notify-names';
import {
  formatOwnerNotifyEmail,
  safeErrorMessage,
  type OwnerNotifyMessage,
} from './owner-notify';
import { getSecretString, parseJsonObjectOrString } from './secrets';

export {
  OWNER_NOTIFY_EVENT_TTL_SECONDS,
  OWNER_NOTIFY_RECIPIENT_ENV,
  OWNER_NOTIFY_RECIPIENT_PARAM_ENV,
  OWNER_NOTIFY_RESEND_API_URL,
  OWNER_NOTIFY_RESEND_SECRET_ARN_ENV,
  OWNER_NOTIFY_RESEND_TIMEOUT_MS,
  OWNER_NOTIFY_SENDER_ENV,
  OWNER_NOTIFY_SENDER_PARAM_ENV,
} from './owner-notify-names';

const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface OwnerNotifyConfig {
  recipient: string;
  sender: string;
}

export type OwnerNotifyFetch = (
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

export interface OwnerNotifySendDeps {
  env?: NodeJS.ProcessEnv;
  nowSeconds?: number;
  ttlSeconds?: number;
  claimEvent?: (message: OwnerNotifyMessage) => Promise<boolean>;
  forgetEvent?: (message: OwnerNotifyMessage) => Promise<void>;
  loadConfig?: () => Promise<OwnerNotifyConfig | undefined>;
  loadApiKey?: () => Promise<string | undefined>;
  getSecret?: (secretId: string) => Promise<string | undefined>;
  http?: OwnerNotifyFetch;
  timeoutMs?: number;
  sendEmail?: (input: {
    sender: string;
    recipient: string;
    subject: string;
    text: string;
    html: string;
  }) => Promise<void>;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

export interface OwnerNotifySsmDeps {
  env?: NodeJS.ProcessEnv;
  getParameter?: (name: string) => Promise<string | undefined>;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

export interface OwnerNotifySecretDeps {
  env?: NodeJS.ProcessEnv;
  getSecret?: (secretId: string) => Promise<string | undefined>;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

const ssm = new SSMClient({});

let cachedConfig: { cacheKey: string; config: OwnerNotifyConfig } | undefined;
let cachedApiKey: string | undefined;

export function resetOwnerNotifyConfigCache(): void {
  cachedConfig = undefined;
  cachedApiKey = undefined;
}

export async function claimOwnerNotifyEvent(
  message: OwnerNotifyMessage,
  options?: { nowSeconds?: number; ttlSeconds?: number },
): Promise<boolean> {
  const providerEventId = message.providerEventId.trim();
  if (!providerEventId) {
    return false;
  }
  const nowSeconds = options?.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttlSeconds = options?.ttlSeconds ?? OWNER_NOTIFY_EVENT_TTL_SECONDS;
  const timestamp = nowIso();
  return putItemIfNotExists({
    PK: keys.ownerNotifyPk(message.provider, providerEventId),
    SK: keys.ownerNotifySk,
    entityType: 'OWNER_NOTIFY',
    userId: message.userId ?? message.provider,
    eventId: providerEventId,
    provider: message.provider,
    createdAt: timestamp,
    updatedAt: timestamp,
    ttl: nowSeconds + ttlSeconds,
  });
}

export async function forgetOwnerNotifyEvent(
  message: OwnerNotifyMessage,
): Promise<void> {
  const providerEventId = message.providerEventId.trim();
  if (!providerEventId) {
    return;
  }
  await deleteItem(
    keys.ownerNotifyPk(message.provider, providerEventId),
    keys.ownerNotifySk,
  );
}

export async function loadOwnerNotifyConfig(
  deps: OwnerNotifySsmDeps = {},
): Promise<OwnerNotifyConfig | undefined> {
  const log = deps.log ?? logger;
  const env = deps.env ?? process.env;
  const fromEnv = envOwnerNotifyConfig(env);
  if (fromEnv) {
    return fromEnv;
  }

  const recipientParam = env[OWNER_NOTIFY_RECIPIENT_PARAM_ENV]?.trim();
  const senderParam = env[OWNER_NOTIFY_SENDER_PARAM_ENV]?.trim();
  if (!recipientParam || !senderParam) {
    log.warn('Owner notify skipped; sender or recipient is not configured');
    return undefined;
  }

  const cacheKey = `${recipientParam}\0${senderParam}`;
  if (cachedConfig && cachedConfig.cacheKey === cacheKey) {
    return cachedConfig.config;
  }

  const getParameter = deps.getParameter ?? getSsmParameter;
  let recipient: string | undefined;
  let sender: string | undefined;
  try {
    [recipient, sender] = await Promise.all([
      getParameter(recipientParam),
      getParameter(senderParam),
    ]);
  } catch (error) {
    log.warn('Owner notify skipped; failed to read SSM parameters', {
      error: safeErrorMessage(error),
    });
    return undefined;
  }

  if (!isNotifyEmail(recipient) || !isNotifyEmail(sender)) {
    log.warn('Owner notify skipped; sender or recipient is missing or invalid');
    return undefined;
  }

  const config = { recipient, sender };
  cachedConfig = { cacheKey, config };
  return config;
}

export async function loadOwnerNotifyApiKey(
  deps: OwnerNotifySecretDeps = {},
): Promise<string | undefined> {
  if (cachedApiKey) {
    return cachedApiKey;
  }
  const log = deps.log ?? logger;
  const env = deps.env ?? process.env;
  const secretId = env[OWNER_NOTIFY_RESEND_SECRET_ARN_ENV]?.trim();
  if (!secretId) {
    log.warn('Owner notify skipped; Resend secret is not configured');
    return undefined;
  }

  const getSecret = deps.getSecret ?? getSecretString;
  try {
    const raw = await getSecret(secretId);
    const apiKey = parseResendApiKey(raw);
    if (!apiKey) {
      log.warn('Owner notify skipped; Resend secret is missing or invalid');
      return undefined;
    }
    cachedApiKey = apiKey;
    return apiKey;
  } catch (error) {
    log.warn('Owner notify skipped; failed to read Resend secret', {
      error: safeErrorMessage(error),
    });
    return undefined;
  }
}

/**
 * Dedupe, load SSM/env + Resend secret, POST to Resend.
 * 429 / 5xx / timeout / network errors forget the claim and throw so SQS
 * retries (then DLQ). Other 4xx are logged with the event ID and dropped.
 * Missing config or secret is a quiet skip (acked).
 */
export async function sendOwnerNotify(
  message: OwnerNotifyMessage,
  deps: OwnerNotifySendDeps = {},
): Promise<void> {
  const log = deps.log ?? logger;
  const claim = deps.claimEvent ?? claimOwnerNotifyEvent;
  const forget = deps.forgetEvent ?? forgetOwnerNotifyEvent;
  const claimed = await claim(message, {
    nowSeconds: deps.nowSeconds,
    ttlSeconds: deps.ttlSeconds,
  });
  if (!claimed) {
    log.info('Owner notify skipped; event already sent', {
      provider: message.provider,
      providerEventId: message.providerEventId,
      eventType: message.eventType,
    });
    return;
  }

  const loadConfig =
    deps.loadConfig ?? (() => loadOwnerNotifyConfig({ env: deps.env, log }));
  let config: OwnerNotifyConfig | undefined;
  try {
    config = await loadConfig();
  } catch (error) {
    log.warn('Owner notify skipped; failed to load config', {
      provider: message.provider,
      providerEventId: message.providerEventId,
      error: safeErrorMessage(error),
    });
    await forget(message);
    return;
  }
  if (!config) {
    await forget(message);
    return;
  }

  const email = formatOwnerNotifyEmail(message);
  const send =
    deps.sendEmail ??
    (async (input: {
      sender: string;
      recipient: string;
      subject: string;
      text: string;
      html: string;
    }) => {
      const loadApiKey =
        deps.loadApiKey ??
        (() =>
          loadOwnerNotifyApiKey({
            env: deps.env,
            getSecret: deps.getSecret,
            log,
          }));
      const apiKey = await loadApiKey();
      if (!apiKey) {
        log.warn('Owner notify skipped; Resend secret is missing or invalid', {
          provider: message.provider,
          providerEventId: message.providerEventId,
        });
        throw new SkipOwnerNotifyError('missing_resend_secret');
      }
      await sendResendEmail({
        apiKey,
        sender: input.sender,
        recipient: input.recipient,
        subject: input.subject,
        text: input.text,
        html: input.html,
        idempotencyKey: message.providerEventId,
        http: deps.http,
        timeoutMs: deps.timeoutMs,
      });
    });
  try {
    await send({
      sender: config.sender,
      recipient: config.recipient,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    log.info('Owner notify sent', {
      provider: message.provider,
      providerEventId: message.providerEventId,
      eventType: message.eventType,
      platform: message.platform,
    });
  } catch (error) {
    if (error instanceof SkipOwnerNotifyError) {
      await forget(message);
      return;
    }
    if (error instanceof PermanentResendError) {
      log.error('Owner notify Resend rejected the request', {
        provider: message.provider,
        providerEventId: message.providerEventId,
        eventType: message.eventType,
        error: safeErrorMessage(error),
      });
      return;
    }
    log.error('Owner notify Resend send failed', {
      provider: message.provider,
      providerEventId: message.providerEventId,
      eventType: message.eventType,
      error: safeErrorMessage(error),
    });
    try {
      await forget(message);
    } catch (forgetError) {
      log.error('Owner notify failed to release dedupe claim', {
        provider: message.provider,
        providerEventId: message.providerEventId,
        error: safeErrorMessage(forgetError),
      });
    }
    throw error;
  }
}

export async function sendResendEmail(input: {
  apiKey: string;
  sender: string;
  recipient: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey?: string;
  http?: OwnerNotifyFetch;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = input.timeoutMs ?? OWNER_NOTIFY_RESEND_TIMEOUT_MS;
  const http = input.http ?? timedFetch(timeoutMs);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (input.idempotencyKey) {
    headers['Idempotency-Key'] = input.idempotencyKey;
  }

  let response: { ok: boolean; status: number; text(): Promise<string> };
  try {
    response = await http(OWNER_NOTIFY_RESEND_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        from: input.sender,
        to: [input.recipient],
        subject: input.subject,
        text: input.text,
        html: input.html,
      }),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error('Resend send timed out');
    }
    throw error;
  }

  try {
    await response.text();
  } catch {
    // Body is unused; never log it.
  }
  if (!response.ok) {
    if (isRetryableResendStatus(response.status)) {
      throw new Error(`Resend send HTTP ${response.status}`);
    }
    throw new PermanentResendError(response.status);
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

class SkipOwnerNotifyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SkipOwnerNotifyError';
  }
}

function isRetryableResendStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function envOwnerNotifyConfig(env: NodeJS.ProcessEnv): OwnerNotifyConfig | undefined {
  const recipient = env[OWNER_NOTIFY_RECIPIENT_ENV]?.trim();
  const sender = env[OWNER_NOTIFY_SENDER_ENV]?.trim();
  if (isNotifyEmail(recipient) && isNotifyEmail(sender)) {
    return { recipient, sender };
  }
  return undefined;
}

function parseResendApiKey(secretString: string | undefined): string | undefined {
  if (!secretString || !secretString.trim()) {
    return undefined;
  }
  const parsed = parseJsonObjectOrString(secretString);
  if (typeof parsed === 'string') {
    return parsed.trim() || undefined;
  }
  return firstString(parsed, ['apiKey', 'api_key', 'key']);
}

function firstString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

async function getSsmParameter(name: string): Promise<string | undefined> {
  try {
    const result = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    return result.Parameter?.Value?.trim() || undefined;
  } catch (error) {
    if (isSsmMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

function timedFetch(timeoutMs: number): OwnerNotifyFetch {
  return async (url, init) => {
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
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function isSsmMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === 'ParameterNotFound' || name === 'ParameterNotFoundException';
}

function isNotifyEmail(value: string | undefined): value is string {
  return Boolean(value && EMAIL_ADDRESS.test(value));
}
