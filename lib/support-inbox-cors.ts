import { Construct } from 'constructs';

/**
 * Browser origins allowed to POST screenshots to the media bucket via
 * presigned POST (WARDROBE-281). Never includes a match-all `*`.
 * `http://localhost:*` is a port wildcard for local web dev.
 */
export const DEFAULT_SUPPORT_INBOX_ALLOWED_ORIGINS: readonly string[] = [
  'https://wende-wardrobe.netlify.app',
  'https://deploy-preview-*--wende-wardrobe.netlify.app',
  'http://localhost:*',
  'http://localhost:5173',
];

export function parseSupportInboxAllowedOrigins(
  raw: string | undefined,
): string[] {
  const origins = (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const resolved =
    origins.length > 0 ? origins : [...DEFAULT_SUPPORT_INBOX_ALLOWED_ORIGINS];

  if (resolved.some((origin) => origin === '*')) {
    throw new Error(
      'supportInboxAllowedOrigins must not include "*". Use explicit origins.',
    );
  }

  return resolved;
}

export function resolveSupportInboxAllowedOrigins(scope: Construct): string[] {
  const fromContext = scope.node.tryGetContext('supportInboxAllowedOrigins');
  const raw =
    typeof fromContext === 'string' && fromContext.trim().length > 0
      ? fromContext.trim()
      : process.env.SUPPORT_INBOX_ALLOWED_ORIGINS;
  return parseSupportInboxAllowedOrigins(raw);
}
