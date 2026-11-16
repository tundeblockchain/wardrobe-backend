import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { logger } from './logger';
import {
  OWNER_NOTIFY_RECIPIENT_ENV,
  OWNER_NOTIFY_RECIPIENT_PARAM_ENV,
  OWNER_NOTIFY_SEND_TIMEOUT_MS,
  OWNER_NOTIFY_SENDER_ENV,
  RESEND_API_KEY_ENV,
  RESEND_SECRET_ARN_ENV,
  SUPPORT_FROM_EMAIL_ENV,
} from './owner-notify-names';
import {
  formatOwnerNotifyEmail,
  ownerNotifyFailureFields,
  type OwnerNotifyMessage,
} from './owner-notify';
import { sendEmail, type FetchLike } from './resend';
import { getSecretString, parseJsonObjectOrString } from './secrets';

export {
  OWNER_NOTIFY_RECIPIENT_ENV,
  OWNER_NOTIFY_RECIPIENT_PARAM_ENV,
  OWNER_NOTIFY_SEND_TIMEOUT_MS,
  OWNER_NOTIFY_SENDER_ENV,
  RESEND_SECRET_ARN_ENV,
} from './owner-notify-names';

const ssm = new SSMClient({});

export interface OwnerNotifyConfig {
  recipient: string;
  sender: string;
}

export interface OwnerNotifySendDeps {
  env?: NodeJS.ProcessEnv;
  loadConfig?: () => Promise<OwnerNotifyConfig | undefined>;
  loadApiKey?: () => Promise<string | undefined>;
  getSecret?: (secretId: string) => Promise<string | undefined>;
  getParameter?: (name: string) => Promise<string | undefined>;
  http?: FetchLike;
  timeoutMs?: number;
  /**
   * Test seam that replaces the Resend send. Production webhooks omit this
   * so the shared client runs with the 3s timeout.
   */
  notifyOwner?: (message: OwnerNotifyMessage) => Promise<void>;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

export interface OwnerNotifyMailDeps {
  env?: NodeJS.ProcessEnv;
  getSecret?: (secretId: string) => Promise<string | undefined>;
  getParameter?: (name: string) => Promise<string | undefined>;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

let cachedConfig: { cacheKey: string; config: OwnerNotifyConfig } | undefined;
let cachedApiKey: string | undefined;

export function resetOwnerNotifyConfigCache(): void {
  cachedConfig = undefined;
  cachedApiKey = undefined;
}

/**
 * Best-effort owner email. Never throws: webhook status and body stay the
 * same whether send succeeds, fails, or times out.
 */
export async function notifyOwnerBestEffort(
  message: OwnerNotifyMessage | undefined,
  deps: OwnerNotifySendDeps = {},
): Promise<void> {
  if (!message) {
    return;
  }
  const log = deps.log ?? logger;
  try {
    if (deps.notifyOwner) {
      await deps.notifyOwner(message);
      return;
    }
    await sendOwnerNotify(message, deps);
  } catch (error) {
    log.error(
      'Owner notify failed',
      ownerNotifyFailureFields(message.providerEventId, error),
    );
  }
}

/**
 * Sender from WARDROBE-38 `fromEmail` (SUPPORT_FROM_EMAIL env). Recipient
 * from OWNER_NOTIFY_RECIPIENT (tests) or the SSM parameter named by
 * OWNER_NOTIFY_RECIPIENT_PARAM. Missing config logs a warning and skips.
 */
export async function loadOwnerNotifyConfig(
  deps: OwnerNotifyMailDeps = {},
): Promise<OwnerNotifyConfig | undefined> {
  const log = deps.log ?? logger;
  const env = deps.env ?? process.env;
  const sender =
    env[OWNER_NOTIFY_SENDER_ENV]?.trim() ||
    env[SUPPORT_FROM_EMAIL_ENV]?.trim();
  const recipientFromEnv = env[OWNER_NOTIFY_RECIPIENT_ENV]?.trim();
  if (recipientFromEnv && sender) {
    return { recipient: recipientFromEnv, sender };
  }
  if (!sender) {
    log.warn('Owner notify skipped; sender or recipient is not configured');
    return undefined;
  }

  const paramName = env[OWNER_NOTIFY_RECIPIENT_PARAM_ENV]?.trim();
  if (!paramName) {
    log.warn('Owner notify skipped; sender or recipient is not configured');
    return undefined;
  }

  if (cachedConfig && cachedConfig.cacheKey === `${paramName}\0${sender}`) {
    return cachedConfig.config;
  }

  const getParameter = deps.getParameter ?? getSsmParameter;
  let recipient: string | undefined;
  try {
    recipient = optionalEmail(await getParameter(paramName));
  } catch (error) {
    log.warn('Owner notify skipped; failed to read recipient parameter', {
      error: ownerNotifyErrorName(error),
    });
    return undefined;
  }
  if (!recipient) {
    log.warn('Owner notify skipped; sender or recipient is missing or invalid');
    return undefined;
  }

  const config = { recipient, sender };
  cachedConfig = { cacheKey: `${paramName}\0${sender}`, config };
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
      error: ownerNotifyErrorName(error),
    });
    return undefined;
  }
}

/**
 * POST via the shared Resend helper with a ~3s timeout.
 * Never throws. Failures log the provider event ID only.
 */
export async function sendOwnerNotify(
  message: OwnerNotifyMessage,
  deps: OwnerNotifySendDeps = {},
): Promise<void> {
  const log = deps.log ?? logger;
  try {
    const loadConfig =
      deps.loadConfig ??
      (() =>
        loadOwnerNotifyConfig({
          env: deps.env,
          getSecret: deps.getSecret,
          getParameter: deps.getParameter,
          log,
        }));
    const config = await loadConfig();
    if (!config) {
      return;
    }

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
      return;
    }

    const email = formatOwnerNotifyEmail(message);
    await sendEmail(
      {
        apiKey,
        from: config.sender,
        to: config.recipient,
        subject: email.subject,
        text: email.text,
        html: email.html,
        idempotencyKey: message.providerEventId,
        timeoutMs: deps.timeoutMs ?? OWNER_NOTIFY_SEND_TIMEOUT_MS,
      },
      deps.http,
    );
    log.info('Owner notify sent', {
      provider: message.provider,
      providerEventId: message.providerEventId,
      eventType: message.eventType,
      platform: message.platform,
    });
  } catch (error) {
    log.error(
      'Owner notify Resend send failed',
      ownerNotifyFailureFields(message.providerEventId, error),
    );
  }
}

function ownerNotifyErrorName(error: unknown): string {
  if (error && typeof error === 'object') {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim()) {
      return name;
    }
  }
  return 'Error';
}

async function getSsmParameter(name: string): Promise<string | undefined> {
  const result = await ssm.send(
    new GetParameterCommand({
      Name: name,
    }),
  );
  const value = result.Parameter?.Value;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalEmail(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
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
