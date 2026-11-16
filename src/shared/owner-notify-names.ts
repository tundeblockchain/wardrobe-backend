/**
 * Owner-notify config names (WARDROBE-273).
 *
 * Keep this module free of AWS clients so CDK synth and the mapping
 * module can import it without pulling Resend, SSM, or Secrets Manager.
 *
 * Runtime mail reuses WARDROBE-38:
 *   RESEND_SECRET_ARN  — existing `wardrobe/<stage>/resend` API key
 *   SUPPORT_FROM_EMAIL — existing support-mail `fromEmail` (injected by CDK)
 * The only new config is the recipient SSM parameter.
 */
export const RESEND_SECRET_ARN_ENV = 'RESEND_SECRET_ARN';
export const RESEND_API_KEY_ENV = 'RESEND_API_KEY';
export const SUPPORT_FROM_EMAIL_ENV = 'SUPPORT_FROM_EMAIL';
/** Optional address overrides (tests). Deployed stages use SSM + WARDROBE-38. */
export const OWNER_NOTIFY_RECIPIENT_ENV = 'OWNER_NOTIFY_RECIPIENT';
export const OWNER_NOTIFY_SENDER_ENV = 'OWNER_NOTIFY_SENDER';
export const OWNER_NOTIFY_RECIPIENT_PARAM_ENV = 'OWNER_NOTIFY_RECIPIENT_PARAM';

/** Best-effort inline send budget so conversion still fits in the webhook timeout. */
export const OWNER_NOTIFY_SEND_TIMEOUT_MS = 3_000;

export function ownerNotifyRecipientParamName(stage: string): string {
  return `/wardrobe/${stage}/owner-notify/recipient`;
}
