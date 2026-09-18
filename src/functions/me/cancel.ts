import { SignJWT, importPKCS8 } from 'jose';
import { StoredEntitlement } from '../../shared/entitlements';
import { logger } from '../../shared/logger';
import { getSecretString } from '../../shared/secrets';
import {
  looksLikePlaceholderCredential,
  parseSuperwallSecret,
  PlayServiceAccount,
  SuperwallSecretConfig,
} from '../../shared/superwall-config';
import {
  EntitlementStore,
  SubscriptionCancelMode,
  SubscriptionCancelResult,
  SubscriptionCancelStatus,
} from '../../shared/types';

const CANCEL_TIMEOUT_MS = 8_000;
const BODY_SNIPPET_MAX = 500;
const PLAY_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const DEFAULT_STRIPE_API_BASE = 'https://api.stripe.com';
const DEFAULT_PLAY_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const PLAY_REVOKE_PATH =
  '/androidpublisher/v3/applications/{package}/purchases/subscriptionsv2/tokens/{token}:revoke';
const PLAY_CANCEL_PATH =
  '/androidpublisher/v3/applications/{package}/purchases/subscriptionsv2/tokens/{token}:cancel';

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
  headers?: { get(name: string): string | null } | Record<string, string>;
  text(): Promise<string>;
}>;

export interface SubscriptionCancelConfig {
  stripeSecretKey?: string;
  stripeApiBase?: string;
  playPackageName?: string;
  playServiceAccount?: PlayServiceAccount;
  /** Test / operator override so unit tests never mint a Google JWT. */
  playAccessToken?: string;
}

export interface CancelSubscriptionInput {
  userId: string;
  entitlement?: StoredEntitlement;
}

export interface SubscriptionCancelClient {
  cancel(input: CancelSubscriptionInput): Promise<SubscriptionCancelResult>;
}

export interface SubscriptionCancelDeps {
  loadConfig?: () => Promise<SubscriptionCancelConfig>;
  fetchImpl?: FetchLike;
  nowMs?: () => number;
}

const ACTIVE_BILLING_STATUSES = new Set([
  'ACTIVE',
  'BILLING_ISSUE',
  'PAUSED',
]);

/**
 * Attempt Superwall/store cancel for account delete (WARDROBE-103).
 *
 * Superwall's public API cannot cancel App Store / Play / Stripe
 * subscriptions. This client talks to Stripe and Google Play when optional
 * credentials are present, then the handler always revokes Dynamo
 * entitlement regardless of the store outcome.
 */
export async function cancelUserSubscription(
  input: CancelSubscriptionInput,
  deps: SubscriptionCancelDeps = {},
): Promise<SubscriptionCancelResult> {
  const entitlement = input.entitlement;
  if (!needsStoreCancel(entitlement)) {
    return noneResult(entitlement);
  }

  const store = entitlement.store;
  const base = baseResult(entitlement);

  if (entitlement.status === 'CANCELED') {
    return {
      ...base,
      status: 'CANCELED',
      cancelMode: periodEndMode(entitlement, deps.nowMs?.() ?? Date.now()),
    };
  }

  const config = await (deps.loadConfig ?? loadSubscriptionCancelConfig)();
  const fetchImpl = deps.fetchImpl ?? fetch;

  try {
    if (store === 'STRIPE') {
      return await cancelStripe(entitlement, config, fetchImpl, base);
    }
    if (store === 'PLAY_STORE') {
      return await cancelPlay(entitlement, config, fetchImpl, base);
    }
    if (store === 'APP_STORE') {
      logger.warn('Subscription cancel skipped; App Store has no server cancel API', {
        store,
        reason: 'app_store_has_no_server_cancel_api',
      });
      return failed(base);
    }

    logger.warn('Subscription cancel skipped; unknown store', {
      store: store ?? 'UNKNOWN',
      reason: 'unknown_store',
    });
    return failed(base);
  } catch (error) {
    logger.warn('Subscription cancel failed', {
      store: store ?? 'UNKNOWN',
      ...safeErrorFields(error),
    });
    return failed(base);
  }
}

export async function loadSubscriptionCancelConfig(): Promise<SubscriptionCancelConfig> {
  const secretId = process.env.SUPERWALL_SECRET_ARN?.trim();
  if (!secretId) {
    return {};
  }
  try {
    return cancelConfigFromSecret(
      parseSuperwallSecret(await getSecretString(secretId)),
    );
  } catch (error) {
    logger.warn('Superwall cancel secret unreadable', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return {};
  }
}

export function cancelConfigFromSecret(
  secret: SuperwallSecretConfig,
): SubscriptionCancelConfig {
  const config: SubscriptionCancelConfig = {};
  if (
    secret.stripeSecretKey &&
    !looksLikePlaceholderCredential(secret.stripeSecretKey)
  ) {
    config.stripeSecretKey = secret.stripeSecretKey;
  }
  if (secret.stripeApiBase && !looksLikePlaceholderCredential(secret.stripeApiBase)) {
    config.stripeApiBase = secret.stripeApiBase.replace(/\/+$/, '');
  }
  if (
    secret.playPackageName &&
    !looksLikePlaceholderCredential(secret.playPackageName)
  ) {
    config.playPackageName = secret.playPackageName;
  }
  if (secret.playServiceAccount) {
    config.playServiceAccount = secret.playServiceAccount;
  }
  return config;
}

function needsStoreCancel(
  entitlement: StoredEntitlement | undefined,
): entitlement is StoredEntitlement {
  if (!entitlement) {
    return false;
  }
  if (entitlement.status === 'NONE' || entitlement.status === 'EXPIRED') {
    return false;
  }
  if (entitlement.status === 'CANCELED') {
    return true;
  }
  return ACTIVE_BILLING_STATUSES.has(entitlement.status);
}

function noneResult(
  entitlement: StoredEntitlement | undefined,
): SubscriptionCancelResult {
  const result: SubscriptionCancelResult = { status: 'NONE' };
  if (entitlement?.store) {
    result.store = entitlement.store;
  }
  if (entitlement?.expiresAt) {
    result.expiresAt = entitlement.expiresAt;
  }
  return result;
}

function baseResult(entitlement: StoredEntitlement): SubscriptionCancelResult {
  const result: SubscriptionCancelResult = { status: 'CANCEL_FAILED' };
  if (entitlement.store) {
    result.store = entitlement.store;
  }
  if (entitlement.expiresAt) {
    result.expiresAt = entitlement.expiresAt;
  }
  return result;
}

function failed(base: SubscriptionCancelResult): SubscriptionCancelResult {
  const result: SubscriptionCancelResult = {
    status: 'CANCEL_FAILED',
    retryInStore: true,
  };
  if (base.store) {
    result.store = base.store;
  }
  if (base.expiresAt) {
    result.expiresAt = base.expiresAt;
  }
  return result;
}

function succeeded(
  base: SubscriptionCancelResult,
  status: Extract<SubscriptionCancelStatus, 'CANCELED' | 'CANCEL_AT_PERIOD_END'>,
  cancelMode: SubscriptionCancelMode,
): SubscriptionCancelResult {
  const result: SubscriptionCancelResult = { status, cancelMode };
  if (base.store) {
    result.store = base.store;
  }
  if (base.expiresAt) {
    result.expiresAt = base.expiresAt;
  }
  return result;
}

function periodEndMode(
  entitlement: StoredEntitlement,
  nowMs: number,
): SubscriptionCancelMode | undefined {
  if (!entitlement.expiresAt) {
    return undefined;
  }
  const expires = Date.parse(entitlement.expiresAt);
  if (!Number.isFinite(expires) || expires <= nowMs) {
    return 'IMMEDIATE';
  }
  return 'PERIOD_END';
}

async function cancelStripe(
  entitlement: StoredEntitlement,
  config: SubscriptionCancelConfig,
  fetchImpl: FetchLike,
  base: SubscriptionCancelResult,
): Promise<SubscriptionCancelResult> {
  const subscriptionId = entitlement.originalTransactionId?.trim();
  if (!config.stripeSecretKey || !subscriptionId) {
    logger.warn('Subscription cancel skipped; Stripe credentials or id missing', {
      store: 'STRIPE',
      reason: config.stripeSecretKey
        ? 'missing_original_transaction_id'
        : 'missing_stripe_secret',
    });
    return failed(base);
  }

  const apiBase = config.stripeApiBase || DEFAULT_STRIPE_API_BASE;
  const url = `${apiBase}/v1/subscriptions/${encodeURIComponent(subscriptionId)}`;
  const response = await timedRequest(fetchImpl, url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${config.stripeSecretKey}`,
      Accept: 'application/json',
    },
  });

  if (response.ok || response.status === 404) {
    return succeeded(base, 'CANCELED', 'IMMEDIATE');
  }

  logHttpFailure('STRIPE', response);
  return failed(base);
}

async function cancelPlay(
  entitlement: StoredEntitlement,
  config: SubscriptionCancelConfig,
  fetchImpl: FetchLike,
  base: SubscriptionCancelResult,
): Promise<SubscriptionCancelResult> {
  const token = entitlement.originalTransactionId?.trim();
  if (!config.playPackageName || !token) {
    logger.warn('Subscription cancel skipped; Play package or token missing', {
      store: 'PLAY_STORE',
      reason: token ? 'missing_play_package_name' : 'missing_play_purchase_token',
    });
    return failed(base);
  }

  const accessToken =
    config.playAccessToken?.trim() ||
    (await mintPlayAccessToken(config.playServiceAccount, fetchImpl));
  if (!accessToken) {
    logger.warn('Subscription cancel skipped; Play access token unavailable', {
      store: 'PLAY_STORE',
      reason: 'missing_play_service_account',
    });
    return failed(base);
  }

  const revokeUrl = playUrl(PLAY_REVOKE_PATH, config.playPackageName, token);
  const revoke = await timedRequest(fetchImpl, revokeUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ revocationContext: { proratedRefund: {} } }),
  });

  if (revoke.ok) {
    return succeeded(base, 'CANCELED', 'IMMEDIATE');
  }

  const cancelUrl = playUrl(PLAY_CANCEL_PATH, config.playPackageName, token);
  const cancel = await timedRequest(fetchImpl, cancelUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      cancellationContext: {
        cancellationType: 'USER_REQUESTED_STOP_RENEWALS',
      },
    }),
  });

  if (cancel.ok) {
    return succeeded(base, 'CANCEL_AT_PERIOD_END', 'PERIOD_END');
  }

  logHttpFailure('PLAY_STORE', revoke.status >= 400 ? revoke : cancel);
  return failed(base);
}

async function mintPlayAccessToken(
  account: PlayServiceAccount | undefined,
  fetchImpl: FetchLike,
): Promise<string | undefined> {
  if (!account?.clientEmail || !account.privateKey) {
    return undefined;
  }

  const key = await importPKCS8(account.privateKey, 'RS256');
  const tokenUri = account.tokenUri || DEFAULT_PLAY_TOKEN_URI;
  const header: { alg: 'RS256'; typ: 'JWT'; kid?: string } = {
    alg: 'RS256',
    typ: 'JWT',
  };
  if (account.privateKeyId) {
    header.kid = account.privateKeyId;
  }

  const assertion = await new SignJWT({ scope: PLAY_PUBLISHER_SCOPE })
    .setProtectedHeader(header)
    .setIssuer(account.clientEmail)
    .setAudience(tokenUri)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);

  const response = await timedRequest(fetchImpl, tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });

  if (!response.ok) {
    logHttpFailure('PLAY_STORE', response);
    return undefined;
  }

  try {
    const parsed = JSON.parse(response.body) as { access_token?: unknown };
    return typeof parsed.access_token === 'string' && parsed.access_token.trim()
      ? parsed.access_token.trim()
      : undefined;
  } catch {
    logger.warn('Subscription cancel failed', {
      store: 'PLAY_STORE',
      status: response.status,
      contentType: response.contentType,
      bodySnippet: truncateBody(response.body),
    });
    return undefined;
  }
}

function playUrl(template: string, packageName: string, token: string): string {
  return `https://androidpublisher.googleapis.com${template
    .replace('{package}', encodeURIComponent(packageName))
    .replace('{token}', encodeURIComponent(token))}`;
}

interface HttpResponse {
  ok: boolean;
  status: number;
  contentType?: string;
  body: string;
}

async function timedRequest(
  fetchImpl: FetchLike,
  url: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CANCEL_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      contentType: headerValue(response.headers, 'content-type'),
      body,
    };
  } finally {
    clearTimeout(timer);
  }
}

function logHttpFailure(store: EntitlementStore, response: HttpResponse): void {
  logger.warn('Subscription cancel failed', {
    store,
    status: response.status,
    contentType: response.contentType,
    bodySnippet: truncateBody(response.body),
  });
}

function truncateBody(body: string, max = BODY_SNIPPET_MAX): string {
  const redacted = body
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /("?(?:apiToken|api_token|token|apiKey|api_key|Authorization|private_key|stripeSecretKey)"?\s*[:=]\s*")[^"]*/gi,
      '$1[redacted]',
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (redacted.length <= max) {
    return redacted;
  }
  return `${redacted.slice(0, max)}…`;
}

function headerValue(
  headers:
    | { get(name: string): string | null }
    | Record<string, string>
    | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(name: string): string | null }).get(name);
    return value?.trim() || undefined;
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    if (key.toLowerCase() === target && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function safeErrorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { errorName: 'UnknownError' };
  }
  const fields: Record<string, unknown> = {
    errorName: error.name,
    reason: error.message,
  };
  if (error.name === 'AbortError' || /aborted/i.test(error.message)) {
    fields.reason = 'timeout';
  }
  return fields;
}
