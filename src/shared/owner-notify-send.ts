import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { deleteItem, keys, putItemIfNotExists } from './dynamodb';
import { nowIso } from './ids';
import { logger } from './logger';
import {
  OWNER_NOTIFY_EVENT_TTL_SECONDS,
  OWNER_NOTIFY_RECIPIENT_ENV,
  OWNER_NOTIFY_RECIPIENT_PARAM_ENV,
  OWNER_NOTIFY_SENDER_ENV,
  OWNER_NOTIFY_SENDER_PARAM_ENV,
} from './owner-notify-names';
import {
  formatOwnerNotifyEmail,
  safeErrorMessage,
  type OwnerNotifyMessage,
} from './owner-notify';

export {
  OWNER_NOTIFY_EVENT_TTL_SECONDS,
  OWNER_NOTIFY_RECIPIENT_ENV,
  OWNER_NOTIFY_RECIPIENT_PARAM_ENV,
  OWNER_NOTIFY_SENDER_ENV,
  OWNER_NOTIFY_SENDER_PARAM_ENV,
} from './owner-notify-names';

const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

const ssm = new SSMClient({});
const ses = new SESClient({});

let cachedConfig: { cacheKey: string; config: OwnerNotifyConfig } | undefined;

export function resetOwnerNotifyConfigCache(): void {
  cachedConfig = undefined;
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

/**
 * Dedupe, load SSM/env, send SES. Throws only after forgetting a claim so
 * SQS can retry SES failures. Missing config is a quiet skip (acked).
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
    ((input: {
      sender: string;
      recipient: string;
      subject: string;
      text: string;
      html: string;
    }) => sendSesEmail(input));
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
    log.error('Owner notify SES send failed', {
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

function envOwnerNotifyConfig(env: NodeJS.ProcessEnv): OwnerNotifyConfig | undefined {
  const recipient = env[OWNER_NOTIFY_RECIPIENT_ENV]?.trim();
  const sender = env[OWNER_NOTIFY_SENDER_ENV]?.trim();
  if (isNotifyEmail(recipient) && isNotifyEmail(sender)) {
    return { recipient, sender };
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

async function sendSesEmail(input: {
  sender: string;
  recipient: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  await ses.send(
    new SendEmailCommand({
      Source: input.sender,
      Destination: { ToAddresses: [input.recipient] },
      Message: {
        Subject: { Data: input.subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: input.text, Charset: 'UTF-8' },
          Html: { Data: input.html, Charset: 'UTF-8' },
        },
      },
    }),
  );
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
