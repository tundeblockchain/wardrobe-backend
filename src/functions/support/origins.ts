/**
 * Origin allowlist for anonymous POST /support/contact (WARDROBE-143).
 *
 * Supports exact origins (`https://pocketcloset.app`) and a single `*`
 * wildcard DNS-label segment (`https://*--pocket-closet.netlify.app`).
 * A bare `*` is not a match-all.
 */

export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function allowedOriginsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return parseAllowedOrigins(env.SUPPORT_CONTACT_ALLOWED_ORIGINS);
}

export function requestOrigin(
  headers?: Record<string, string | undefined> | null,
): string | undefined {
  const raw = headers?.origin ?? headers?.Origin;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Missing Origin (curl / mobile) is allowed. Browser Origin-bearing
 * requests must match the allowlist. An empty allowlist rejects every
 * Origin-bearing call.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowlist: string[],
): boolean {
  if (!origin) {
    return true;
  }
  if (allowlist.length === 0) {
    return false;
  }
  return allowlist.some((pattern) => originMatches(origin, pattern));
}

export function originMatches(origin: string, pattern: string): boolean {
  if (origin === pattern) {
    return true;
  }
  const stars = pattern.split('*').length - 1;
  if (stars !== 1) {
    return false;
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(
    /\*/g,
    '[^.]+',
  );
  return new RegExp(`^${escaped}$`).test(origin);
}
