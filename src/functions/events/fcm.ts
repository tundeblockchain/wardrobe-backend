import { deleteItem, keys, queryByPk } from '../../shared/dynamodb';
import { logger } from '../../shared/logger';
import { getSecretString, parseJsonObjectOrString } from '../../shared/secrets';
import { DevicePlatform, DynamoItem, JobEventJobType } from '../../shared/types';
import { isOwnedDevice } from './model';
import { JobDoneInput } from './model';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_TTL_MS = 50 * 60 * 1000;

export interface FcmServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export interface FcmDeps {
  getSecretString?: (secretId: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  importPrivateKey?: (pem: string) => Promise<unknown>;
  signJwt?: (account: FcmServiceAccount, nowSeconds: number) => Promise<string>;
  nowMs?: () => number;
}

interface CachedAccessToken {
  token: string;
  expiresAtMs: number;
}

let cachedAccessToken: CachedAccessToken | undefined;

export function resetFcmAccessTokenCache(): void {
  cachedAccessToken = undefined;
}

/**
 * Optional Firebase service-account JSON for FCM HTTP v1.
 *
 * Secret path: `wardrobe/{stage}/firebase-fcm` (ARN on `FIREBASE_FCM_SECRET_ARN`).
 * Accepts standard Google JSON (`project_id`, `client_email`, `private_key`)
 * or camelCase `{ projectId, clientEmail, privateKey }`.
 *
 * Missing / placeholder / unparseable secrets skip push — never 5xx.
 */
export function parseFcmServiceAccount(
  secretString: string,
): FcmServiceAccount | undefined {
  const parsed = parseJsonObjectOrString(secretString);
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

export function jobDoneNotificationCopy(input: JobDoneInput): {
  title: string;
  body: string;
} {
  if (input.jobType === 'PROCESS_WARDROBE_ITEM') {
    return input.status === 'READY'
      ? { title: 'Item ready', body: 'Your clothing item has finished processing.' }
      : { title: 'Item processing failed', body: 'We could not finish processing this item.' };
  }
  if (input.jobType === 'RENDER_ITEM') {
    return input.status === 'READY'
      ? { title: 'Try-on ready', body: 'Your Virtual Try On is ready to view.' }
      : { title: 'Try-on failed', body: 'We could not finish this try-on.' };
  }
  return input.status === 'READY'
    ? { title: 'Try-on ready', body: 'Your outfit try-on is ready to view.' }
    : { title: 'Try-on failed', body: 'We could not finish this try-on.' };
}

export function jobDonePushData(input: JobDoneInput, eventId: string): Record<string, string> {
  const data: Record<string, string> = {
    eventId,
    jobType: input.jobType,
    status: input.status,
    wardrobeId: input.wardrobeId,
  };
  if (input.itemId) {
    data.itemId = input.itemId;
  }
  if (input.outfitId) {
    data.outfitId = input.outfitId;
  }
  if (input.renderId) {
    data.renderId = input.renderId;
  }
  if (input.aiProfileId) {
    data.aiProfileId = input.aiProfileId;
  }
  return data;
}

/**
 * Best-effort FCM fan-out. Missing secret, missing tokens, and invalid
 * tokens never throw — workers must not 5xx because of push.
 */
export async function sendJobDonePush(
  input: JobDoneInput,
  eventId: string,
  deps: FcmDeps = {},
): Promise<{ attempted: number; sent: number }> {
  const secretArn = process.env.FIREBASE_FCM_SECRET_ARN?.trim();
  if (!secretArn) {
    logger.info('Skipping FCM: FIREBASE_FCM_SECRET_ARN is not set');
    return { attempted: 0, sent: 0 };
  }

  const loadSecret = deps.getSecretString ?? getSecretString;
  let account: FcmServiceAccount | undefined;
  try {
    account = parseFcmServiceAccount(await loadSecret(secretArn));
  } catch (error) {
    logger.warn('Skipping FCM: failed to read firebase-fcm secret', {
      error: error instanceof Error ? error.message : 'unknown',
    });
    return { attempted: 0, sent: 0 };
  }
  if (!account) {
    logger.info('Skipping FCM: firebase-fcm secret is not a service-account JSON');
    return { attempted: 0, sent: 0 };
  }

  let devices: DynamoItem[];
  try {
    devices = (await queryByPk(keys.userPk(input.userId), keys.deviceSkPrefix)).filter(
      (item) => isOwnedDevice(item, input.userId) && typeof item.token === 'string',
    );
  } catch (error) {
    logger.warn('Skipping FCM: failed to list device tokens', {
      error: error instanceof Error ? error.message : 'unknown',
    });
    return { attempted: 0, sent: 0 };
  }

  if (devices.length === 0) {
    logger.info('Skipping FCM: no registered device tokens', {
      userId: input.userId,
      eventId,
    });
    return { attempted: 0, sent: 0 };
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(account, deps);
  } catch (error) {
    logger.warn('Skipping FCM: failed to mint access token', {
      error: error instanceof Error ? error.message : 'unknown',
    });
    return { attempted: 0, sent: 0 };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const copy = jobDoneNotificationCopy(input);
  const data = jobDonePushData(input, eventId);
  let sent = 0;

  for (const device of devices) {
    const token = String(device.token);
    try {
      const response = await fetchImpl(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token,
              data,
              notification: copy,
              android: { priority: 'high' },
              apns: {
                payload: {
                  aps: { sound: 'default' },
                },
              },
            },
          }),
        },
      );
      if (response.ok) {
        sent += 1;
        continue;
      }
      const body = await safeReadBody(response);
      if (isUnusableToken(response.status, body)) {
        await deleteStaleDevice(input.userId, String(device.deviceId));
      }
      logger.warn('FCM send soft-failed', {
        status: response.status,
        deviceId: device.deviceId,
        platform: device.platform as DevicePlatform | undefined,
        jobType: input.jobType as JobEventJobType,
      });
    } catch (error) {
      logger.warn('FCM send soft-failed', {
        deviceId: device.deviceId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  return { attempted: devices.length, sent };
}

async function getAccessToken(
  account: FcmServiceAccount,
  deps: FcmDeps,
): Promise<string> {
  const nowMs = deps.nowMs ?? Date.now;
  if (cachedAccessToken && cachedAccessToken.expiresAtMs > nowMs()) {
    return cachedAccessToken.token;
  }

  const nowSeconds = Math.floor(nowMs() / 1000);
  const assertion = deps.signJwt
    ? await deps.signJwt(account, nowSeconds)
    : await signGoogleJwt(account, nowSeconds, deps);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Google OAuth token exchange failed (${response.status})`);
  }
  const payload = (await response.json()) as { access_token?: unknown };
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new Error('Google OAuth token exchange returned no access_token');
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
  deps: FcmDeps,
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

async function deleteStaleDevice(userId: string, deviceId: string): Promise<void> {
  try {
    await deleteItem(keys.userPk(userId), keys.deviceSk(deviceId));
  } catch (error) {
    logger.warn('Failed to delete stale FCM device token', {
      deviceId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
}

async function safeReadBody(response: Response): Promise<string> {
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
