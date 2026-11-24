import { logger } from '../../shared/logger';
import { parseJsonObjectOrString } from '../../shared/secrets';
import {
  FCM_SERVICE_ACCOUNT_SECRET_ARN_ENV,
  SUPPORT_PUSH_TIMEOUT_MS,
  SUPPORT_REPLY_PUSH_BODY,
  SUPPORT_REPLY_PUSH_DATA_TYPE,
  SUPPORT_REPLY_PUSH_TITLE,
  readSupportPushTimeoutMs,
  type SupportPushStatus,
} from '../../shared/support-inbox-names';
import { safeReplyFailureFields } from './alert';
import { hashDeviceToken } from './model';
import {
  deleteSupportItem,
  queryDevicesByUid,
} from './table';
import { keys } from './keys';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_TTL_MS = 50 * 60 * 1000;

export interface FcmServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

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
  json(): Promise<unknown>;
}>;

export interface SupportReplyPushInput {
  conversationId: string;
  messageId: string;
  uid?: string;
}

export interface SupportReplyPushDeps {
  env?: NodeJS.ProcessEnv;
  getSecretString?: (secretId: string) => Promise<string>;
  listDevices?: (uid: string) => Promise<Array<Record<string, unknown>>>;
  deleteDevice?: (uid: string, token: string) => Promise<void>;
  fetchImpl?: FetchLike;
  importPrivateKey?: (pem: string) => Promise<unknown>;
  signJwt?: (account: FcmServiceAccount, nowSeconds: number) => Promise<string>;
  nowMs?: () => number;
  timeoutMs?: number;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

interface CachedAccessToken {
  token: string;
  expiresAtMs: number;
}

let cachedAccount:
  | { secretId: string; account: FcmServiceAccount | undefined }
  | undefined;
let cachedAccessToken: CachedAccessToken | undefined;

export function resetSupportFcmCache(): void {
  cachedAccount = undefined;
  cachedAccessToken = undefined;
}

/**
 * FCM HTTP v1 payload for an admin reply. Both `notification` (system
 * tray / lock screen) and `data` (tap deep-link) are required so a tap
 * opens the app when it is backgrounded or terminated.
 */
export function buildSupportReplyFcmMessage(input: {
  token: string;
  conversationId: string;
}): {
  message: {
    token: string;
    notification: { title: string; body: string };
    data: { type: string; conversationId: string };
    android: {
      priority: 'high';
      notification: { click_action: string };
    };
    apns: {
      headers: { 'apns-priority': string };
      payload: { aps: { sound: string; 'content-available': number } };
    };
  };
} {
  return {
    message: {
      token: input.token,
      notification: {
        title: SUPPORT_REPLY_PUSH_TITLE,
        body: SUPPORT_REPLY_PUSH_BODY,
      },
      data: {
        type: SUPPORT_REPLY_PUSH_DATA_TYPE,
        conversationId: input.conversationId,
      },
      android: {
        priority: 'high',
        notification: {
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
        },
      },
      apns: {
        headers: {
          'apns-priority': '10',
        },
        payload: {
          aps: {
            sound: 'default',
            'content-available': 1,
          },
        },
      },
    },
  };
}

/**
 * Optional Firebase service-account JSON for FCM HTTP v1.
 *
 * Secret path: `wardrobe/{stage}/fcm-service-account`
 * (ARN on `FCM_SERVICE_ACCOUNT_SECRET_ARN`).
 * Accepts standard Google JSON or camelCase.
 *
 * Missing / placeholder / unparseable secrets skip push — never 5xx.
 */
export function parseFcmServiceAccount(
  secretString: string,
): FcmServiceAccount | undefined {
  let parsed: Record<string, unknown> | string;
  try {
    parsed = parseJsonObjectOrString(secretString);
  } catch {
    return undefined;
  }
  if (typeof parsed === 'string') {
    return undefined;
  }
  const projectId = firstString(parsed.project_id, parsed.projectId);
  const clientEmail = firstString(parsed.client_email, parsed.clientEmail);
  const privateKey = firstString(parsed.private_key, parsed.privateKey);
  if (!projectId || !clientEmail || !privateKey) {
    return undefined;
  }
  return {
    projectId,
    clientEmail,
    privateKey: privateKey.replace(/\\n/g, '\n'),
  };
}

/**
 * Best-effort FCM fan-out after an admin reply is stored. Missing uid,
 * tokens, or credential skip. Timeouts, 4xx/5xx, and thrown errors never
 * propagate. No message text, tokens, or other PII in logs.
 */
export async function sendSupportReplyPushBestEffort(
  input: SupportReplyPushInput,
  deps: SupportReplyPushDeps = {},
): Promise<SupportPushStatus> {
  const log = deps.log ?? logger;
  try {
    return await sendSupportReplyPush(input, deps);
  } catch (error) {
    log.error(
      'Support inbox push failed',
      safeReplyFailureFields(input.conversationId, input.messageId, error),
    );
    return 'failed';
  }
}

export async function sendSupportReplyPush(
  input: SupportReplyPushInput,
  deps: SupportReplyPushDeps = {},
): Promise<SupportPushStatus> {
  const log = deps.log ?? logger;
  const uid = input.uid?.trim();
  if (!uid) {
    log.info('Support inbox push skipped', {
      conversationId: input.conversationId,
      messageId: input.messageId,
      reason: 'UidMissing',
    });
    return 'skipped';
  }

  const account = await loadFcmServiceAccount(deps);
  if (!account) {
    log.info('Support inbox push skipped', {
      conversationId: input.conversationId,
      messageId: input.messageId,
      reason: 'CredentialMissing',
    });
    return 'skipped';
  }

  const listDevices = deps.listDevices ?? queryDevicesByUid;
  let devices: Array<Record<string, unknown>>;
  try {
    devices = (await listDevices(uid)).filter(
      (item) =>
        item.entityType === 'SUPPORT_DEVICE' &&
        item.uid === uid &&
        typeof item.token === 'string' &&
        item.token.length > 0,
    );
  } catch (error) {
    log.warn(
      'Support inbox push failed',
      safeReplyFailureFields(input.conversationId, input.messageId, error),
    );
    return 'failed';
  }

  if (devices.length === 0) {
    log.info('Support inbox push skipped', {
      conversationId: input.conversationId,
      messageId: input.messageId,
      reason: 'NoTokens',
    });
    return 'skipped';
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(account, deps);
  } catch (error) {
    log.warn(
      'Support inbox push failed',
      safeReplyFailureFields(input.conversationId, input.messageId, error),
    );
    return 'failed';
  }

  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const timeoutMs = deps.timeoutMs ?? readSupportPushTimeoutMs(deps.env);
  const deleteDevice = deps.deleteDevice ?? deleteStaleDevice;
  let sent = 0;

  for (const device of devices) {
    const token = String(device.token);
    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(
            buildSupportReplyFcmMessage({
              token,
              conversationId: input.conversationId,
            }),
          ),
        },
        timeoutMs,
      );
      if (response.ok) {
        sent += 1;
        continue;
      }
      const body = await safeReadBody(response);
      if (isUnusableToken(response.status, body)) {
        await deleteDevice(uid, token);
      }
      log.warn('Support inbox push failed', {
        conversationId: input.conversationId,
        messageId: input.messageId,
        error: `FcmHttp${response.status}`,
      });
    } catch (error) {
      log.warn(
        'Support inbox push failed',
        safeReplyFailureFields(input.conversationId, input.messageId, error),
      );
    }
  }

  return sent > 0 ? 'sent' : 'failed';
}

async function loadFcmServiceAccount(
  deps: SupportReplyPushDeps,
): Promise<FcmServiceAccount | undefined> {
  const env = deps.env ?? process.env;
  const secretId = env[FCM_SERVICE_ACCOUNT_SECRET_ARN_ENV]?.trim();
  if (!secretId) {
    return undefined;
  }
  if (cachedAccount && cachedAccount.secretId === secretId) {
    return cachedAccount.account;
  }

  const loadSecret = deps.getSecretString ?? getSecretString;
  let account: FcmServiceAccount | undefined;
  try {
    account = parseFcmServiceAccount(await loadSecret(secretId));
  } catch {
    account = undefined;
  }
  cachedAccount = { secretId, account };
  return account;
}

async function getAccessToken(
  account: FcmServiceAccount,
  deps: SupportReplyPushDeps,
): Promise<string> {
  const nowMs = deps.nowMs ?? Date.now;
  if (cachedAccessToken && cachedAccessToken.expiresAtMs > nowMs()) {
    return cachedAccessToken.token;
  }

  const nowSeconds = Math.floor(nowMs() / 1000);
  const assertion = deps.signJwt
    ? await deps.signJwt(account, nowSeconds)
    : await signGoogleJwt(account, nowSeconds, deps);
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const timeoutMs = deps.timeoutMs ?? readSupportPushTimeoutMs(deps.env);
  const response = await fetchWithTimeout(
    fetchImpl,
    GOOGLE_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    },
    timeoutMs,
  );
  if (!response.ok) {
    throw new Error(`GoogleOAuthHttp${response.status}`);
  }
  const payload = (await response.json()) as { access_token?: unknown };
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new Error('GoogleOAuthMissingAccessToken');
  }
  cachedAccessToken = {
    token: payload.access_token,
    expiresAtMs: nowMs() + TOKEN_TTL_MS,
  };
  return payload.access_token;
}

async function signGoogleJwt(
  account: FcmServiceAccount,
  nowSeconds: number,
  deps: SupportReplyPushDeps,
): Promise<string> {
  const { SignJWT, importPKCS8 } = await import('jose');
  const key = deps.importPrivateKey
    ? ((await deps.importPrivateKey(account.privateKey)) as Awaited<
        ReturnType<typeof importPKCS8>
      >)
    : await importPKCS8(account.privateKey, 'RS256');
  return new SignJWT({ scope: FCM_SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(account.clientEmail)
    .setSubject(account.clientEmail)
    .setAudience(GOOGLE_TOKEN_URL)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 3600)
    .sign(key);
}

async function deleteStaleDevice(uid: string, token: string): Promise<void> {
  try {
    await deleteSupportItem(keys.devicePk(uid), keys.deviceSk(hashDeviceToken(token)));
  } catch (error) {
    logger.warn('Support inbox push failed', {
      error: error instanceof Error ? error.name : 'UnknownError',
      reason: 'StaleTokenDeleteFailed',
    });
  }
}

async function getSecretString(secretId: string): Promise<string> {
  const { GetSecretValueCommand, SecretsManagerClient } = await import(
    '@aws-sdk/client-secrets-manager'
  );
  const client = new SecretsManagerClient({
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: SUPPORT_PUSH_TIMEOUT_MS,
      requestTimeout: SUPPORT_PUSH_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
  });
  const result = await client.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  const value = result.SecretString?.trim();
  if (!value) {
    throw new Error('SecretEmpty');
  }
  return value;
}

function fetchWithTimeout(
  http: FetchLike,
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
  timeoutMs: number,
): Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
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

function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}> {
  return fetch(url, init);
}

async function safeReadBody(response: {
  text(): Promise<string>;
}): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function isUnusableToken(status: number, body: string): boolean {
  if (status === 404) {
    return true;
  }
  const upper = body.toUpperCase();
  return (
    upper.includes('UNREGISTERED') ||
    upper.includes('INVALID_ARGUMENT') ||
    upper.includes('NOT_FOUND')
  );
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
