import { Construct } from 'constructs';

/**
 * Default browser origins allowed to PUT to the media bucket via
 * presigned URLs (WARDROBE-176). Never includes `*`.
 */
export const DEFAULT_UPLOAD_ALLOWED_ORIGINS: readonly string[] = [
  'https://wende-wardrobe.netlify.app',
  'https://deploy-preview-*--wende-wardrobe.netlify.app',
  'http://localhost:5173',
];

export function parseUploadAllowedOrigins(raw: string | undefined): string[] {
  const origins = (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const resolved =
    origins.length > 0 ? origins : [...DEFAULT_UPLOAD_ALLOWED_ORIGINS];

  if (resolved.some((origin) => origin === '*')) {
    throw new Error(
      'uploadAllowedOrigins must not include "*". Use explicit origins.',
    );
  }

  return resolved;
}

export function resolveUploadAllowedOrigins(scope: Construct): string[] {
  const fromContext = scope.node.tryGetContext('uploadAllowedOrigins');
  const raw =
    typeof fromContext === 'string' && fromContext.trim().length > 0
      ? fromContext.trim()
      : process.env.UPLOAD_ALLOWED_ORIGINS;
  return parseUploadAllowedOrigins(raw);
}
