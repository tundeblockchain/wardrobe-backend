/**
 * Support inbox config names (WARDROBE-281).
 *
 * Keep this module free of AWS clients so CDK synth can import it without
 * pulling Resend, SSM, S3, or DynamoDB.
 *
 * Runtime mail reuses WARDROBE-38:
 *   RESEND_SECRET_ARN  — existing `wardrobe/<stage>/resend` API key
 *   SUPPORT_FROM_EMAIL — existing support-mail `fromEmail` (injected by CDK)
 * The only new config is the recipient SSM parameter.
 */

export const RESEND_SECRET_ARN_ENV = 'RESEND_SECRET_ARN';
export const RESEND_API_KEY_ENV = 'RESEND_API_KEY';
export const SUPPORT_FROM_EMAIL_ENV = 'SUPPORT_FROM_EMAIL';
export const SUPPORT_TABLE_NAME_ENV = 'SUPPORT_TABLE_NAME';

/** Optional address override (tests). Deployed stages use SSM. */
export const SUPPORT_INBOX_RECIPIENT_ENV = 'SUPPORT_INBOX_RECIPIENT';
export const SUPPORT_INBOX_RECIPIENT_PARAM_ENV = 'SUPPORT_INBOX_RECIPIENT_PARAM';

/** Optional "Open in Pocket Closet" URL override (tests / CDK context). */
export const SUPPORT_INBOX_APP_LINK_ENV = 'SUPPORT_INBOX_APP_LINK';
export const SUPPORT_INBOX_APP_LINK_PARAM_ENV = 'SUPPORT_INBOX_APP_LINK_PARAM';

export const SUPPORT_INBOX_ALLOWED_ORIGINS_ENV = 'SUPPORT_INBOX_ALLOWED_ORIGINS';
export const SUPPORT_FEEDBACK_IP_RATE_LIMIT_ENV = 'SUPPORT_FEEDBACK_IP_RATE_LIMIT';
export const SUPPORT_FEEDBACK_EMAIL_RATE_LIMIT_ENV =
  'SUPPORT_FEEDBACK_EMAIL_RATE_LIMIT';
export const SUPPORT_UPLOAD_IP_RATE_LIMIT_ENV = 'SUPPORT_UPLOAD_IP_RATE_LIMIT';
export const SUPPORT_INBOX_RATE_WINDOW_SECONDS_ENV =
  'SUPPORT_INBOX_RATE_WINDOW_SECONDS';

export const DEFAULT_FEEDBACK_IP_RATE_LIMIT = 5;
export const DEFAULT_FEEDBACK_EMAIL_RATE_LIMIT = 5;
export const DEFAULT_UPLOAD_IP_RATE_LIMIT = 20;
export const DEFAULT_RATE_WINDOW_SECONDS = 3600;

/**
 * Best-effort Resend send budget so the client is never blocked on mail.
 * Override with env SUPPORT_EMAIL_TIMEOUT_MS.
 */
export const SUPPORT_EMAIL_TIMEOUT_MS = 3_000;
export const SUPPORT_EMAIL_TIMEOUT_MS_ENV = 'SUPPORT_EMAIL_TIMEOUT_MS';

export const SUPPORT_EMAIL_STATUSES = ['sent', 'failed', 'skipped'] as const;
export type SupportEmailStatus = (typeof SUPPORT_EMAIL_STATUSES)[number];

/**
 * Transient retry-email claim. Not a client-facing emailStatus.
 * Claim condition: author=admin AND (emailStatus=failed OR a sending
 * claim whose updatedAt is older than SUPPORT_EMAIL_RETRY_CLAIM_STALE_MS).
 * Sets this value so only one caller may send.
 */
export const SUPPORT_EMAIL_RETRY_CLAIM_STATUS = 'sending' as const;
export type SupportEmailRetryClaimStatus =
  typeof SUPPORT_EMAIL_RETRY_CLAIM_STATUS;

/**
 * A `sending` claim older than this may be taken over. Equal to
 * 2 × SUPPORT_EMAIL_TIMEOUT_MS so a live send is not stolen.
 */
export const SUPPORT_EMAIL_RETRY_CLAIM_STALE_MS =
  2 * SUPPORT_EMAIL_TIMEOUT_MS;

export function supportEmailRetryClaimStaleBefore(now: string): string {
  return new Date(
    Date.parse(now) - SUPPORT_EMAIL_RETRY_CLAIM_STALE_MS,
  ).toISOString();
}

export function readSupportEmailTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[SUPPORT_EMAIL_TIMEOUT_MS_ENV]?.trim();
  if (!raw) {
    return SUPPORT_EMAIL_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : SUPPORT_EMAIL_TIMEOUT_MS;
}
/** Cold-start SSM / Secrets reads; cached after the first hit. */
export const SUPPORT_INBOX_AWS_REQUEST_TIMEOUT_MS = 1_000;
export const SUPPORT_INBOX_AWS_MAX_ATTEMPTS = 1;

export const SUPPORT_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
export const SUPPORT_PRESIGN_EXPIRES_SECONDS = 900;
export const SUPPORT_KEY_PREFIX = 'support/';

export const SUPPORT_FEEDBACK_TYPES = ['bug', 'query'] as const;
export type SupportFeedbackType = (typeof SUPPORT_FEEDBACK_TYPES)[number];

export const SUPPORT_PLATFORMS = ['ios', 'android', 'web'] as const;
export type SupportPlatform = (typeof SUPPORT_PLATFORMS)[number];

export const SUPPORT_UPLOAD_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
] as const;
export type SupportUploadContentType =
  (typeof SUPPORT_UPLOAD_CONTENT_TYPES)[number];

export const SUPPORT_CONVERSATION_STATUSES = [
  'open',
  'replied',
  'closed',
] as const;
export type SupportConversationStatus =
  (typeof SUPPORT_CONVERSATION_STATUSES)[number];

export const SUPPORT_MESSAGE_AUTHORS = ['user', 'admin'] as const;
export type SupportMessageAuthor = (typeof SUPPORT_MESSAGE_AUTHORS)[number];

export const LAST_MESSAGE_PREVIEW_CHARS = 140;
export const DEFAULT_ADMIN_LIST_LIMIT = 50;
export const ADMIN_LIST_LIMIT_MIN = 1;
export const ADMIN_LIST_LIMIT_MAX = 100;

export const DEFAULT_USER_LIST_LIMIT = DEFAULT_ADMIN_LIST_LIMIT;
export const USER_LIST_LIMIT_MIN = ADMIN_LIST_LIMIT_MIN;
export const USER_LIST_LIMIT_MAX = ADMIN_LIST_LIMIT_MAX;

/**
 * Max conversations scanned when totaling `unreadCount` on
 * GET /support/my/conversations. The returned count is capped at this.
 */
export const SUPPORT_UNREAD_COUNT_MAX = 200;

export const SUPPORT_DEVICE_PLATFORMS = ['ios', 'android'] as const;
export type SupportDevicePlatform = (typeof SUPPORT_DEVICE_PLATFORMS)[number];
export const DEVICE_TOKEN_MIN_CHARS = 1;
export const DEVICE_TOKEN_MAX_CHARS = 4096;

export const SUPPORT_PUSH_STATUSES = ['sent', 'failed', 'skipped'] as const;
export type SupportPushStatus = (typeof SUPPORT_PUSH_STATUSES)[number];

/**
 * Best-effort FCM HTTP v1 budget so an admin reply never waits on push.
 * Override with env SUPPORT_PUSH_TIMEOUT_MS.
 */
export const SUPPORT_PUSH_TIMEOUT_MS = 3_000;
export const SUPPORT_PUSH_TIMEOUT_MS_ENV = 'SUPPORT_PUSH_TIMEOUT_MS';
export const FCM_SERVICE_ACCOUNT_SECRET_ARN_ENV =
  'FCM_SERVICE_ACCOUNT_SECRET_ARN';

export const SUPPORT_REPLY_PUSH_TITLE = 'Pocket Closet Support';
export const SUPPORT_REPLY_PUSH_BODY = 'You have a new reply';
export const SUPPORT_REPLY_PUSH_DATA_TYPE = 'support_reply';

export function readSupportPushTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[SUPPORT_PUSH_TIMEOUT_MS_ENV]?.trim();
  if (!raw) {
    return SUPPORT_PUSH_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : SUPPORT_PUSH_TIMEOUT_MS;
}

export function fcmServiceAccountSecretName(stage: string): string {
  return `wardrobe/${stage}/fcm-service-account`;
}

export function supportInboxRecipientParamName(stage: string): string {
  return `/wardrobe/${stage}/support/recipient`;
}

export function supportInboxAppLinkParamName(stage: string): string {
  return `/wardrobe/${stage}/support/app-link`;
}

export function supportTableName(stage: string): string {
  return `wardrobe-support-${stage}`;
}
