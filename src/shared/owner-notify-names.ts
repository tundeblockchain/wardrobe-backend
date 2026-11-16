/**
 * Owner-notify config names (WARDROBE-273).
 *
 * Keep this module free of AWS clients so CDK synth and the webhook
 * Lambdas can import it without pulling Resend or Secrets Manager.
 *
 * Runtime mail uses the WARDROBE-38 env names:
 *   RESEND_SECRET_ARN, SUPPORT_MAIL_SECRET_ARN
 * plus optional test overrides OWNER_NOTIFY_RECIPIENT / OWNER_NOTIFY_SENDER.
 */
export const OWNER_NOTIFY_QUEUE_URL_ENV = 'OWNER_NOTIFY_QUEUE_URL';
export const RESEND_SECRET_ARN_ENV = 'RESEND_SECRET_ARN';
export const SUPPORT_MAIL_SECRET_ARN_ENV = 'SUPPORT_MAIL_SECRET_ARN';
export const RESEND_API_KEY_ENV = 'RESEND_API_KEY';
export const SUPPORT_FROM_EMAIL_ENV = 'SUPPORT_FROM_EMAIL';
export const SUPPORT_FORWARD_TO_ENV = 'SUPPORT_FORWARD_TO';
/** Optional address overrides (tests). Prefer the WARDROBE-38 secrets in deployed stages. */
export const OWNER_NOTIFY_RECIPIENT_ENV = 'OWNER_NOTIFY_RECIPIENT';
export const OWNER_NOTIFY_SENDER_ENV = 'OWNER_NOTIFY_SENDER';

export const OWNER_NOTIFY_EVENT_TTL_SECONDS = 90 * 24 * 60 * 60;
