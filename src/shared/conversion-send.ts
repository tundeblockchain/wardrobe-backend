import { logger } from './logger';
import { getSecretString, parseJsonObjectOrString } from './secrets';
import { looksLikePlaceholderCredential } from './superwall-config';
import { checkoutEventSourceUrl } from './billing-urls';
import { ConversionEvent } from './conversion-events';

export const META_CAPI_SECRET_ARN_ENV = 'META_CAPI_SECRET_ARN';
export const TIKTOK_EVENTS_SECRET_ARN_ENV = 'TIKTOK_EVENTS_SECRET_ARN';

export const META_CAPI_GRAPH_VERSION = 'v21.0';
export const TIKTOK_EVENTS_URL =
  'https://business-api.tiktok.com/open_api/v1.3/event/track/';

/** Bounded so tracking cannot consume the webhook Lambda timeout. */
export const CONVERSION_MAX_ATTEMPTS = 2;
export const CONVERSION_BACKOFF_MS = [100] as const;
export const CONVERSION_HTTP_TIMEOUT_MS = 1500;
/** Wall-clock cap for both platforms (parallel). Well under the 20s Lambda timeout. */
export const CONVERSION_DEADLINE_MS = 4000;

export interface ConversionPlatformSecret {
  id: string;
  accessToken: string;
  testEventCode?: string;
}

export interface ConversionSendDeps {
  env?: NodeJS.ProcessEnv;
  getSecretString?: (secretId: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

type SecretCacheEntry =
  | { arn: string; secret: ConversionPlatformSecret }
  | { arn: string; skip: true };

let metaSecretCache: SecretCacheEntry | undefined;
let tiktokSecretCache: SecretCacheEntry | undefined;

export function resetConversionSecretCaches(): void {
  metaSecretCache = undefined;
  tiktokSecretCache = undefined;
}

export function parseMetaCapiSecret(
  secretString: string,
): ConversionPlatformSecret | undefined {
  return parsePlatformSecret(secretString, ['pixelId', 'pixel_id', 'PIXEL_ID']);
}

export function parseTikTokEventsSecret(
  secretString: string,
): ConversionPlatformSecret | undefined {
  return parsePlatformSecret(secretString, [
    'pixelCode',
    'pixel_code',
    'PIXEL_CODE',
    'pixelId',
    'pixel_id',
  ]);
}

export function buildMetaCapiPayload(
  event: ConversionEvent,
  testEventCode?: string,
): Record<string, unknown> {
  const userData: Record<string, unknown> = {
    external_id: event.externalId,
  };
  if (event.actionSource === 'website' && event.clientUserAgent) {
    userData.client_user_agent = event.clientUserAgent;
  }
  const body: Record<string, unknown> = {
    event_name: event.eventName,
    event_time: event.eventTimeSeconds,
    event_id: event.eventId,
    action_source: event.actionSource,
    user_data: userData,
  };
  if (event.actionSource === 'website' && event.eventSourceUrl) {
    body.event_source_url = event.eventSourceUrl;
  }
  const customData = customDataOf(event);
  if (customData) {
    body.custom_data = customData;
  }
  const payload: Record<string, unknown> = { data: [body] };
  if (testEventCode) {
    payload.test_event_code = testEventCode;
  }
  return payload;
}

export function buildTikTokEventsPayload(
  event: ConversionEvent,
  pixelCode: string,
  testEventCode?: string,
): Record<string, unknown> {
  const user: Record<string, unknown> = {
    external_id: event.externalId,
  };
  if (event.actionSource !== 'app' && event.clientUserAgent) {
    user.user_agent = event.clientUserAgent;
  }
  const item: Record<string, unknown> = {
    event: event.eventName,
    event_time: event.eventTimeSeconds,
    event_id: event.eventId,
    user,
  };
  if (event.actionSource !== 'app') {
    item.page = {
      url: event.eventSourceUrl ?? checkoutEventSourceUrl(),
    };
  }
  const properties = customDataOf(event);
  if (properties) {
    item.properties = properties;
  }
  const payload: Record<string, unknown> = {
    event_source: event.actionSource === 'app' ? 'app' : 'web',
    event_source_id: pixelCode,
    data: [item],
  };
  if (testEventCode) {
    payload.test_event_code = testEventCode;
  }
  return payload;
}

/**
 * Best-effort send to Meta CAPI and TikTok Events API.
 * Never throws. Missing / placeholder secrets skip at info. HTTP failures
 * retry a bounded number of times with backoff, then log and return.
 */
export async function sendConversionEvent(
  event: ConversionEvent | undefined,
  deps: ConversionSendDeps = {},
): Promise<void> {
  if (!event) {
    return;
  }
  const log = deps.log ?? logger;
  const nowMs = deps.nowMs ?? Date.now;
  const deadlineMs = nowMs() + CONVERSION_DEADLINE_MS;
  try {
    await Promise.all([
      sendMeta(event, deps, log, deadlineMs),
      sendTikTok(event, deps, log, deadlineMs),
    ]);
  } catch (error) {
    log.error('Conversion tracking failed', {
      eventName: event.eventName,
      eventId: event.eventId,
      error: safeErrorMessage(error),
    });
  }
}

async function sendMeta(
  event: ConversionEvent,
  deps: ConversionSendDeps,
  log: Pick<typeof logger, 'info' | 'warn' | 'error'>,
  deadlineMs: number,
): Promise<void> {
  if (event.actionSource === 'app') {
    log.info('Skipping Meta CAPI for app-sourced event; app SDK sends Meta', {
      eventName: event.eventName,
      eventId: event.eventId,
    });
    return;
  }
  const secret = await loadCachedSecret({
    envKey: META_CAPI_SECRET_ARN_ENV,
    cache: metaSecretCache,
    setCache: (entry) => {
      metaSecretCache = entry;
    },
    parse: parseMetaCapiSecret,
    platform: 'meta',
    deps,
    log,
  });
  if (!secret) {
    return;
  }

  const url = `https://graph.facebook.com/${META_CAPI_GRAPH_VERSION}/${encodeURIComponent(secret.id)}/events`;
  const payload = buildMetaCapiPayload(event, secret.testEventCode);
  await postWithRetries({
    platform: 'meta',
    event,
    url,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        access_token: secret.accessToken,
      }),
    },
    isSuccess: (status, body) => status >= 200 && status < 300 && !metaError(body),
    deps,
    log,
    deadlineMs,
  });
}

async function sendTikTok(
  event: ConversionEvent,
  deps: ConversionSendDeps,
  log: Pick<typeof logger, 'info' | 'warn' | 'error'>,
  deadlineMs: number,
): Promise<void> {
  const secret = await loadCachedSecret({
    envKey: TIKTOK_EVENTS_SECRET_ARN_ENV,
    cache: tiktokSecretCache,
    setCache: (entry) => {
      tiktokSecretCache = entry;
    },
    parse: parseTikTokEventsSecret,
    platform: 'tiktok',
    deps,
    log,
  });
  if (!secret) {
    return;
  }

  const payload = buildTikTokEventsPayload(
    event,
    secret.id,
    secret.testEventCode,
  );
  await postWithRetries({
    platform: 'tiktok',
    event,
    url: TIKTOK_EVENTS_URL,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Access-Token': secret.accessToken,
      },
      body: JSON.stringify(payload),
    },
    isSuccess: (status, body) =>
      status >= 200 && status < 300 && tiktokCode(body) === 0,
    deps,
    log,
    deadlineMs,
  });
}

async function loadCachedSecret(options: {
  envKey: string;
  cache: SecretCacheEntry | undefined;
  setCache: (entry: SecretCacheEntry) => void;
  parse: (secretString: string) => ConversionPlatformSecret | undefined;
  platform: 'meta' | 'tiktok';
  deps: ConversionSendDeps;
  log: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}): Promise<ConversionPlatformSecret | undefined> {
  const env = options.deps.env ?? process.env;
  const arn = env[options.envKey]?.trim();
  if (!arn) {
    options.log.info('Skipping conversion; secret ARN is not set', {
      platform: options.platform,
    });
    return undefined;
  }
  if (options.cache && options.cache.arn === arn) {
    return 'skip' in options.cache ? undefined : options.cache.secret;
  }

  const load = options.deps.getSecretString ?? getSecretString;
  let raw: string;
  try {
    raw = await load(arn);
  } catch (error) {
    options.log.info('Skipping conversion; failed to read secret', {
      platform: options.platform,
      error: safeErrorMessage(error),
    });
    return undefined;
  }

  const secret = options.parse(raw);
  if (!secret) {
    options.log.info('Skipping conversion; secret is a placeholder or incomplete', {
      platform: options.platform,
    });
    options.setCache({ arn, skip: true });
    return undefined;
  }
  options.setCache({ arn, secret });
  return secret;
}

async function postWithRetries(options: {
  platform: 'meta' | 'tiktok';
  event: ConversionEvent;
  url: string;
  init: RequestInit;
  isSuccess: (status: number, body: string) => boolean;
  deps: ConversionSendDeps;
  log: Pick<typeof logger, 'info' | 'warn' | 'error'>;
  deadlineMs: number;
}): Promise<void> {
  const fetchImpl = options.deps.fetchImpl ?? fetch;
  const sleep = options.deps.sleep ?? defaultSleep;
  const nowMs = options.deps.nowMs ?? Date.now;
  let lastError: string = 'unknown';
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= CONVERSION_MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = options.deadlineMs - nowMs();
    if (remainingMs <= 0) {
      options.log.warn('Conversion tracking deadline reached', {
        platform: options.platform,
        eventName: options.event.eventName,
        eventId: options.event.eventId,
        attempt,
      });
      return;
    }
    try {
      const controller = new AbortController();
      const timeoutMs = Math.min(CONVERSION_HTTP_TIMEOUT_MS, remainingMs);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(options.url, {
          ...options.init,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      lastStatus = response.status;
      const body = await safeReadBody(response);
      if (options.isSuccess(response.status, body)) {
        options.log.info('Conversion event sent', {
          platform: options.platform,
          eventName: options.event.eventName,
          eventId: options.event.eventId,
          attempt,
        });
        return;
      }
      lastError = `status ${response.status}`;
      const retryable = isRetryableStatus(response.status);
      const platformErrorCode = platformErrorCodeOf(options.platform, body);
      const fields = {
        platform: options.platform,
        eventName: options.event.eventName,
        eventId: options.event.eventId,
        attempt,
        status: response.status,
        retryable,
        ...(platformErrorCode !== undefined ? { platformErrorCode } : {}),
      };
      if (!retryable && response.status >= 400 && response.status < 500) {
        options.log.error('Conversion platform request failed', fields);
        return;
      }
      options.log.warn('Conversion platform request failed', fields);
      if (!retryable || attempt === CONVERSION_MAX_ATTEMPTS) {
        return;
      }
    } catch (error) {
      lastError = safeErrorMessage(error);
      options.log.warn('Conversion platform request failed', {
        platform: options.platform,
        eventName: options.event.eventName,
        eventId: options.event.eventId,
        attempt,
        error: lastError,
        retryable: true,
      });
      if (attempt === CONVERSION_MAX_ATTEMPTS) {
        return;
      }
    }
    const backoff = CONVERSION_BACKOFF_MS[attempt - 1] ?? 100;
    if (nowMs() + backoff >= options.deadlineMs) {
      return;
    }
    await sleep(backoff);
  }

  options.log.error('Conversion platform exhausted retries', {
    platform: options.platform,
    eventName: options.event.eventName,
    eventId: options.event.eventId,
    status: lastStatus,
    error: lastError,
  });
}

function parsePlatformSecret(
  secretString: string,
  idKeys: string[],
): ConversionPlatformSecret | undefined {
  const parsed = parseJsonObjectOrString(secretString);
  if (typeof parsed === 'string') {
    return undefined;
  }
  const id = firstString(parsed, idKeys);
  const accessToken = firstString(parsed, [
    'accessToken',
    'access_token',
    'ACCESS_TOKEN',
    'token',
  ]);
  if (
    !id ||
    !accessToken ||
    looksLikePlaceholderCredential(id) ||
    looksLikePlaceholderCredential(accessToken)
  ) {
    return undefined;
  }
  const testEventCode = firstString(parsed, [
    'testEventCode',
    'test_event_code',
    'TEST_EVENT_CODE',
  ]);
  const secret: ConversionPlatformSecret = { id, accessToken };
  if (testEventCode && !looksLikePlaceholderCredential(testEventCode)) {
    secret.testEventCode = testEventCode;
  }
  return secret;
}

function customDataOf(
  event: ConversionEvent,
): { value: number; currency: string } | { value: number } | { currency: string } | undefined {
  const hasValue = typeof event.value === 'number' && Number.isFinite(event.value);
  const currency = event.currency?.trim().toUpperCase();
  if (hasValue && currency) {
    return { value: event.value as number, currency };
  }
  if (hasValue) {
    return { value: event.value as number };
  }
  if (currency) {
    return { currency };
  }
  return undefined;
}

function metaError(body: string): boolean {
  if (!body.trim()) {
    return false;
  }
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return Boolean(parsed.error);
  } catch {
    return false;
  }
}

function tiktokCode(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed.code === 'number' ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function platformErrorCodeOf(
  platform: 'meta' | 'tiktok',
  body: string,
): string | number | undefined {
  if (!body.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (platform === 'tiktok') {
      return typeof parsed.code === 'number' ? parsed.code : undefined;
    }
    const error = asJsonRecord(parsed.error);
    if (!error) {
      return undefined;
    }
    if (typeof error.code === 'number' || typeof error.code === 'string') {
      return error.code;
    }
    if (typeof error.type === 'string' && error.type.trim()) {
      return error.type.trim();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function asJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
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

export function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'unknown';
  return raw
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/Access-Token\s*:\s*\S+/gi, 'Access-Token: [redacted]')
    .replace(/access_token=[^&\s"]+/gi, 'access_token=[redacted]')
    .replace(/EAA[A-Za-z0-9]+/g, '[redacted]');
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
