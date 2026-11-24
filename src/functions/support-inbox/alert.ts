import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { logger } from '../../shared/logger';
import { PermanentResendError, sendEmail, type FetchLike } from '../../shared/resend';
import { parseJsonObjectOrString } from '../../shared/secrets';
import {
  RESEND_API_KEY_ENV,
  RESEND_SECRET_ARN_ENV,
  SUPPORT_FROM_EMAIL_ENV,
  SUPPORT_INBOX_AWS_MAX_ATTEMPTS,
  SUPPORT_INBOX_AWS_REQUEST_TIMEOUT_MS,
  SUPPORT_INBOX_RECIPIENT_ENV,
  SUPPORT_INBOX_RECIPIENT_PARAM_ENV,
  readSupportEmailTimeoutMs,
  type SupportEmailStatus,
  type SupportFeedbackType,
  type SupportPlatform,
} from '../../shared/support-inbox-names';

const AWS_CLIENT_CONFIG = {
  maxAttempts: SUPPORT_INBOX_AWS_MAX_ATTEMPTS,
  requestHandler: {
    connectionTimeout: SUPPORT_INBOX_AWS_REQUEST_TIMEOUT_MS,
    requestTimeout: SUPPORT_INBOX_AWS_REQUEST_TIMEOUT_MS,
    throwOnRequestTimeout: true,
  },
};

const ssm = new SSMClient(AWS_CLIENT_CONFIG);
const secrets = new SecretsManagerClient(AWS_CLIENT_CONFIG);

export interface SupportInboxAlert {
  conversationId: string;
  type: SupportFeedbackType;
  message: string;
  email: string;
  platform: SupportPlatform;
  appVersion?: string;
  device?: string;
  uid?: string;
  screenshotKey?: string;
}

export interface SupportInboxMailConfig {
  recipient: string;
  sender: string;
}

export interface SupportInboxAlertDeps {
  env?: NodeJS.ProcessEnv;
  loadConfig?: () => Promise<SupportInboxMailConfig | undefined>;
  loadApiKey?: () => Promise<string | undefined>;
  getSecret?: (secretId: string) => Promise<string | undefined>;
  getParameter?: (name: string) => Promise<string | undefined>;
  http?: FetchLike;
  timeoutMs?: number;
  sendAlert?: (alert: SupportInboxAlert) => Promise<void>;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

export interface SupportAlertFailureFields {
  conversationId: string;
  error: string;
  code?: string | number;
  [key: string]: unknown;
}

let cachedConfig: { cacheKey: string; config: SupportInboxMailConfig } | undefined;
let cachedApiKey: string | undefined;

export function resetSupportInboxAlertCache(): void {
  cachedConfig = undefined;
  cachedApiKey = undefined;
}

/**
 * Best-effort support inbox email. Never throws. The HTTP status stays 201
 * once the conversation is stored, whether send succeeds, fails, times out,
 * or config is missing. Timeout is SUPPORT_EMAIL_TIMEOUT_MS.
 */
export async function sendSupportInboxAlertBestEffort(
  alert: SupportInboxAlert,
  deps: SupportInboxAlertDeps = {},
): Promise<SupportEmailStatus> {
  const log = deps.log ?? logger;
  try {
    if (deps.sendAlert) {
      await deps.sendAlert(alert);
      return 'sent';
    }
    return await sendSupportInboxAlert(alert, deps);
  } catch (error) {
    log.error('Support inbox alert failed', safeAlertFailureFields(alert.conversationId, error));
    return 'failed';
  }
}

export async function sendSupportInboxAlert(
  alert: SupportInboxAlert,
  deps: SupportInboxAlertDeps = {},
): Promise<SupportEmailStatus> {
  const log = deps.log ?? logger;
  const loadConfig =
    deps.loadConfig ??
    (() =>
      loadSupportInboxMailConfig({
        env: deps.env,
        getParameter: deps.getParameter,
        log,
      }));
  const config = await loadConfig();
  if (!config) {
    log.warn(
      'Support inbox alert skipped',
      safeAlertFailureFields(alert.conversationId, 'RecipientMissing'),
    );
    return 'skipped';
  }

  const loadApiKey =
    deps.loadApiKey ??
    (() =>
      loadSupportInboxApiKey({
        env: deps.env,
        getSecret: deps.getSecret,
        log,
      }));
  const apiKey = await loadApiKey();
  if (!apiKey) {
    log.error(
      'Support inbox alert failed',
      safeAlertFailureFields(alert.conversationId, 'ApiKeyMissing'),
    );
    return 'failed';
  }

  const email = formatSupportInboxAlert(alert);
  const timeoutMs = deps.timeoutMs ?? readSupportEmailTimeoutMs(deps.env);
  await sendEmail(
    {
      apiKey,
      from: config.sender,
      to: config.recipient,
      subject: email.subject,
      text: email.text,
      replyTo: alert.email,
      timeoutMs,
    },
    deps.http,
  );
  log.info('Support inbox alert sent', {
    conversationId: alert.conversationId,
    type: alert.type,
    platform: alert.platform,
    hasUid: Boolean(alert.uid),
    hasScreenshot: Boolean(alert.screenshotKey),
  });
  return 'sent';
}

/**
 * Failure log fields: conversationId + error class/code only.
 * Never include email, message text, keys, or secrets.
 */
export function safeAlertFailureFields(
  conversationId: string,
  error: unknown,
): SupportAlertFailureFields {
  const fields: SupportAlertFailureFields = {
    conversationId,
    error: errorClass(error),
  };
  const code = errorCode(error);
  if (code !== undefined) {
    fields.code = code;
  }
  return fields;
}

/**
 * Reply / retry failure logs: conversationId + messageId + error class/code.
 * Never include email, message text, keys, or tokens.
 */
export function safeReplyFailureFields(
  conversationId: string,
  messageId: string,
  error: unknown,
): SupportAlertFailureFields & { messageId: string } {
  return {
    ...safeAlertFailureFields(conversationId, error),
    messageId,
  };
}

/**
 * Support inbox recipient for Reply-To (admin replies) and To (alerts).
 * Missing/unset is undefined — callers omit Reply-To and still send.
 */
export async function loadSupportInboxRecipient(
  deps: SupportInboxAlertDeps = {},
): Promise<string | undefined> {
  const env = deps.env ?? process.env;
  const fromEnv = env[SUPPORT_INBOX_RECIPIENT_ENV]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const paramName = env[SUPPORT_INBOX_RECIPIENT_PARAM_ENV]?.trim();
  if (!paramName) {
    return undefined;
  }
  const getParameter = deps.getParameter ?? getSsmParameter;
  try {
    return optionalNonEmpty(await getParameter(paramName));
  } catch {
    return undefined;
  }
}

export async function loadSupportInboxMailConfig(
  deps: SupportInboxAlertDeps = {},
): Promise<SupportInboxMailConfig | undefined> {
  const env = deps.env ?? process.env;
  const sender = env[SUPPORT_FROM_EMAIL_ENV]?.trim();
  const recipientFromEnv = env[SUPPORT_INBOX_RECIPIENT_ENV]?.trim();
  if (recipientFromEnv && sender) {
    return { recipient: recipientFromEnv, sender };
  }
  if (!sender) {
    return undefined;
  }

  const paramName = env[SUPPORT_INBOX_RECIPIENT_PARAM_ENV]?.trim();
  if (!paramName) {
    return undefined;
  }

  if (cachedConfig && cachedConfig.cacheKey === `${paramName}\0${sender}`) {
    return cachedConfig.config;
  }

  const getParameter = deps.getParameter ?? getSsmParameter;
  let recipient: string | undefined;
  try {
    recipient = optionalNonEmpty(await getParameter(paramName));
  } catch {
    return undefined;
  }
  if (!recipient) {
    return undefined;
  }

  const config = { recipient, sender };
  cachedConfig = { cacheKey: `${paramName}\0${sender}`, config };
  return config;
}

export async function loadSupportInboxApiKey(
  deps: SupportInboxAlertDeps = {},
): Promise<string | undefined> {
  const env = deps.env ?? process.env;
  const fromEnv = env[RESEND_API_KEY_ENV]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (cachedApiKey) {
    return cachedApiKey;
  }
  const secretId = env[RESEND_SECRET_ARN_ENV]?.trim();
  if (!secretId) {
    return undefined;
  }

  const getSecret = deps.getSecret ?? getSecretString;
  try {
    const apiKey = parseResendApiKey(await getSecret(secretId));
    if (!apiKey) {
      return undefined;
    }
    cachedApiKey = apiKey;
    return apiKey;
  } catch {
    return undefined;
  }
}

export function formatSupportInboxAlert(alert: SupportInboxAlert): {
  subject: string;
  text: string;
} {
  const subject = `[Wardrobe support] ${alert.type}: ${alert.conversationId}`;
  const lines = [
    'A new support conversation was opened.',
    '',
    `Type: ${alert.type}`,
    `Conversation ID: ${alert.conversationId}`,
    `Email: ${alert.email}`,
    `Platform: ${alert.platform}`,
    `App version: ${alert.appVersion ?? '(not provided)'}`,
    `Device: ${alert.device ?? '(not provided)'}`,
    `UID: ${alert.uid ?? '(anonymous)'}`,
    `Screenshot: ${alert.screenshotKey ? 'yes' : 'no'}`,
    '',
    'Message:',
    alert.message,
  ];
  return { subject, text: lines.join('\n') };
}

export async function getSsmParameter(name: string): Promise<string | undefined> {
  const result = await ssm.send(
    new GetParameterCommand({
      Name: name,
    }),
  );
  const value = result.Parameter?.Value;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function getSecretString(secretId: string): Promise<string | undefined> {
  const result = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  const value = result.SecretString?.trim();
  return value || undefined;
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

function optionalNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function errorClass(error: unknown): string {
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === 'object') {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim()) {
      return name.trim();
    }
  }
  return 'Error';
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error === 'string') {
    return undefined;
  }
  if (isTimeoutError(error)) {
    return 'TIMEOUT';
  }
  if (error instanceof PermanentResendError) {
    return error.status;
  }
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim()) {
      return code.trim();
    }
    if (typeof code === 'number' && Number.isFinite(code)) {
      return code;
    }
  }
  return undefined;
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const named = error as { name?: unknown; message?: unknown };
  if (named.name === 'AbortError' || named.name === 'TimeoutError') {
    return true;
  }
  return named.message === 'Resend send timed out';
}
