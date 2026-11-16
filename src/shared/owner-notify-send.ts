import { deleteItem, keys, putItemIfNotExists } from './dynamodb';
import { nowIso } from './ids';
import { logger } from './logger';
import {
  OWNER_NOTIFY_EVENT_TTL_SECONDS,
  OWNER_NOTIFY_RECIPIENT_ENV,
  OWNER_NOTIFY_SENDER_ENV,
  RESEND_API_KEY_ENV,
  RESEND_SECRET_ARN_ENV,
  SUPPORT_FORWARD_TO_ENV,
  SUPPORT_FROM_EMAIL_ENV,
  SUPPORT_MAIL_SECRET_ARN_ENV,
} from './owner-notify-names';
import {
  formatOwnerNotifyEmail,
  safeErrorMessage,
  type OwnerNotifyMessage,
} from './owner-notify';
import {
  PermanentResendError,
  sendEmail,
  type FetchLike,
} from './resend';
import { getSecretString, parseJsonObjectOrString } from './secrets';

export {
  OWNER_NOTIFY_EVENT_TTL_SECONDS,
  OWNER_NOTIFY_RECIPIENT_ENV,
  OWNER_NOTIFY_SENDER_ENV,
  RESEND_SECRET_ARN_ENV,
  SUPPORT_MAIL_SECRET_ARN_ENV,
} from './owner-notify-names';

export { PermanentResendError } from './resend';

export interface OwnerNotifyConfig {
  recipient: string;
  sender: string;
}

export interface OwnerNotifySendDeps {
  env?: NodeJS.ProcessEnv;
  nowSeconds?: number;
  ttlSeconds?: number;
  claimEvent?: (message: OwnerNotifyMessage) => Promise<boolean>;
  forgetEvent?: (message: OwnerNotifyMessage) => Promise<void>;
  loadConfig?: () => Promise<OwnerNotifyConfig | undefined>;
  loadApiKey?: () => Promise<string | undefined>;
  getSecret?: (secretId: string) => Promise<string | undefined>;
  http?: FetchLike;
  sendEmail?: (input: {
    sender: string;
    recipient: string;
    subject: string;
    text: string;
    html: string;
  }) => Promise<void>;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

export interface OwnerNotifyMailDeps {
  env?: NodeJS.ProcessEnv;
  getSecret?: (secretId: string) => Promise<string | undefined>;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

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

/**
 * From-address and recipient from the WARDROBE-38 support-mail secret
 * (`fromEmail` / `forwardTo`), with env overrides for tests.
 */
export async function loadOwnerNotifyConfig(
  deps: OwnerNotifyMailDeps = {},
): Promise<OwnerNotifyConfig | undefined> {
  const log = deps.log ?? logger;
  const env = deps.env ?? process.env;
  const fromEnv = envOwnerNotifyConfig(env);
  if (fromEnv) {
    return fromEnv;
  }

  const secretId = env[SUPPORT_MAIL_SECRET_ARN_ENV]?.trim();
  if (!secretId) {
    log.warn('Owner notify skipped; sender or recipient is not configured');
    return undefined;
  }

  if (cachedConfig && cachedConfig.cacheKey === secretId) {
    return cachedConfig.config;
  }

  const getSecret = deps.getSecret ?? getSecretString;
  let parsed: Partial<OwnerNotifyConfig> = {};
  try {
    parsed = parseMailAddresses(await getSecret(secretId));
  } catch (error) {
    log.warn('Owner notify skipped; failed to read support-mail secret', {
      error: safeErrorMessage(error),
    });
    return undefined;
  }

  const sender = parsed.sender;
  const recipient = parsed.recipient;
  if (!sender || !recipient) {
    log.warn('Owner notify skipped; sender or recipient is missing or invalid');
    return undefined;
  }

  const config = { recipient, sender };
  cachedConfig = { cacheKey: secretId, config };
  return config;
}

export async function loadOwnerNotifyApiKey(
  deps: OwnerNotifyMailDeps = {},
): Promise<string | undefined> {
  const env = deps.env ?? process.env;
  const fromEnv = env[RESEND_API_KEY_ENV]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (cachedApiKey) {
    return cachedApiKey;
  }
  const log = deps.log ?? logger;
  const secretId = env[RESEND_SECRET_ARN_ENV]?.trim();
  if (!secretId) {
    log.warn('Owner notify skipped; Resend secret is not configured');
    return undefined;
  }

  const getSecret = deps.getSecret ?? getSecretString;
  try {
    const apiKey = parseResendApiKey(await getSecret(secretId));
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
 * Dedupe, load the WARDROBE-38 Resend + support-mail secrets, POST via the
 * shared Resend helper.
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
    deps.loadConfig ??
    (() =>
      loadOwnerNotifyConfig({
        env: deps.env,
        getSecret: deps.getSecret,
        log,
      }));
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
      await sendEmail(
        {
          apiKey,
          from: input.sender,
          to: input.recipient,
          subject: input.subject,
          text: input.text,
          html: input.html,
          idempotencyKey: message.providerEventId,
        },
        deps.http,
      );
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

class SkipOwnerNotifyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SkipOwnerNotifyError';
  }
}

function envOwnerNotifyConfig(env: NodeJS.ProcessEnv): OwnerNotifyConfig | undefined {
  const recipient =
    env[OWNER_NOTIFY_RECIPIENT_ENV]?.trim() || env[SUPPORT_FORWARD_TO_ENV]?.trim();
  const sender =
    env[OWNER_NOTIFY_SENDER_ENV]?.trim() || env[SUPPORT_FROM_EMAIL_ENV]?.trim();
  if (recipient && sender) {
    return { recipient, sender };
  }
  return undefined;
}

function parseMailAddresses(
  secretString: string | undefined,
): Partial<OwnerNotifyConfig> {
  if (!secretString || !secretString.trim()) {
    return {};
  }
  const parsed = parseJsonObjectOrString(secretString);
  if (typeof parsed === 'string') {
    return {};
  }
  const sender = firstString(parsed, ['fromEmail', 'from', SUPPORT_FROM_EMAIL_ENV]);
  const recipient = firstString(parsed, [
    'forwardTo',
    'to',
    SUPPORT_FORWARD_TO_ENV,
  ]);
  return {
    ...(sender ? { sender } : {}),
    ...(recipient ? { recipient } : {}),
  };
}

function parseResendApiKey(secretString: string | undefined): string | undefined {
  if (!secretString || !secretString.trim()) {
    return undefined;
  }
  const parsed = parseJsonObjectOrString(secretString);
  if (typeof parsed === 'string') {
    return parsed.trim() || undefined;
  }
  return firstString(parsed, ['apiKey', 'api_key', 'key', RESEND_API_KEY_ENV]);
}

function firstString(
  record: Record<string, unknown>,
  keysToTry: string[],
): string | undefined {
  for (const key of keysToTry) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
