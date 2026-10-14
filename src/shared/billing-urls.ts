import { Errors } from './errors';

/**
 * Server-built Stripe Checkout and Billing Portal return URLs
 * (WARDROBE-189 / WARDROBE-191 / WARDROBE-198).
 *
 * Success / cancel / return URLs are never taken from the request body.
 * The configured web origin comes from CDK context / env `billingWebOrigin`
 * (`BILLING_WEB_ORIGIN` at runtime). There is no hardcoded default.
 *
 * The request `Origin` header is used only when it is https and matches an
 * allowlist entry exactly on scheme + host + port. Non-allowlisted,
 * non-https, or missing Origin falls back to the configured base URL.
 * No config → `BILLING_NOT_CONFIGURED`.
 */
export const BILLING_WEB_ORIGIN_ENV = 'BILLING_WEB_ORIGIN';

/** Literal Stripe placeholder — must appear in success_url unchanged. */
export const CHECKOUT_SESSION_ID_PLACEHOLDER = '{CHECKOUT_SESSION_ID}';

interface HttpsOriginParts {
  hostname: string;
  /** Empty string means the https default port (443). */
  port: string;
}

/**
 * Parse a value as an https origin (scheme + host + port only).
 * Rejects http, credentials, paths, query, hash, and invalid URLs.
 */
export function parseHttpsOrigin(value: string): HttpsOriginParts | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      return undefined;
    }
    if (url.username || url.password) {
      return undefined;
    }
    if (url.pathname !== '/' || url.search || url.hash) {
      return undefined;
    }
    const hostname = url.hostname.toLowerCase();
    if (!hostname || hostname.includes('*')) {
      return undefined;
    }
    return {
      hostname,
      port: url.port === '443' ? '' : url.port,
    };
  } catch {
    return undefined;
  }
}

export function formatHttpsOrigin(parts: HttpsOriginParts): string {
  return parts.port
    ? `https://${parts.hostname}:${parts.port}`
    : `https://${parts.hostname}`;
}

/**
 * Exact scheme + host + port equality. No prefix, suffix, or substring
 * matching — `https://evil-custom.com` does not match `https://custom.com`.
 */
export function originsEqualExactly(left: string, right: string): boolean {
  const a = parseHttpsOrigin(left);
  const b = parseHttpsOrigin(right);
  return Boolean(a && b && a.hostname === b.hostname && a.port === b.port);
}

export function isAllowlistedHttpsOrigin(
  origin: string,
  allowlist: string[],
): boolean {
  const parsed = parseHttpsOrigin(origin);
  if (!parsed) {
    return false;
  }
  return allowlist.some((entry) => originsEqualExactly(origin, entry));
}

/**
 * Canonical https origin, or `undefined` when missing / not https.
 * Does not default to any domain.
 */
export function normalizeBillingWebOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return undefined;
  }
  const parts = parseHttpsOrigin(trimmed);
  return parts ? formatHttpsOrigin(parts) : undefined;
}

export function requireBillingWebOrigin(value?: unknown): string {
  const origin = normalizeBillingWebOrigin(value);
  if (!origin) {
    throw Errors.billingNotConfigured();
  }
  return origin;
}

export function resolveBillingWebOrigin(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return requireBillingWebOrigin(env[BILLING_WEB_ORIGIN_ENV]);
}

export interface BillingReturnOriginInput {
  configured?: unknown;
  requestOrigin?: string;
  allowlist?: string[];
}

/**
 * Configured base URL is required. Prefer `requestOrigin` only when it is
 * https and equals an allowlist entry (or the configured base) exactly on
 * scheme + host + port. Otherwise use the configured base.
 */
export function resolveBillingReturnOrigin(
  input: BillingReturnOriginInput = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = requireBillingWebOrigin(
    input.configured ?? env[BILLING_WEB_ORIGIN_ENV],
  );
  const requestOrigin = input.requestOrigin?.trim();
  if (!requestOrigin) {
    return configured;
  }

  const allowlist = [configured, ...(input.allowlist ?? [])];
  if (isAllowlistedHttpsOrigin(requestOrigin, allowlist)) {
    const parts = parseHttpsOrigin(requestOrigin);
    return parts ? formatHttpsOrigin(parts) : configured;
  }
  return configured;
}

export function checkoutSuccessUrl(origin: string): string {
  const base = requireBillingWebOrigin(origin);
  return `${base}/app/billing/success?session_id=${CHECKOUT_SESSION_ID_PLACEHOLDER}`;
}

export function checkoutCancelUrl(origin: string): string {
  const base = requireBillingWebOrigin(origin);
  return `${base}/app/billing/cancel`;
}

export function checkoutReturnUrls(origin?: string): {
  successUrl: string;
  cancelUrl: string;
} {
  const resolved = requireBillingWebOrigin(origin);
  return {
    successUrl: checkoutSuccessUrl(resolved),
    cancelUrl: checkoutCancelUrl(resolved),
  };
}

/** Billing Portal return — settings plan hash. Never from the request body. */
export function portalReturnUrl(origin?: string): string {
  const base = requireBillingWebOrigin(origin);
  return `${base}/app/settings#plan`;
}
