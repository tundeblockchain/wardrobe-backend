/**
 * Owner-notify config names (WARDROBE-273).
 *
 * Keep this module free of AWS clients so CDK synth and the webhook
 * Lambdas can import it without pulling Resend or Secrets Manager.
 */
export const OWNER_NOTIFY_QUEUE_URL_ENV = 'OWNER_NOTIFY_QUEUE_URL';
export const OWNER_NOTIFY_RECIPIENT_PARAM_ENV = 'OWNER_NOTIFY_RECIPIENT_PARAM';
export const OWNER_NOTIFY_SENDER_PARAM_ENV = 'OWNER_NOTIFY_SENDER_PARAM';
export const OWNER_NOTIFY_RESEND_SECRET_ARN_ENV = 'OWNER_NOTIFY_RESEND_SECRET_ARN';
/** Optional direct addresses (tests / overrides). Prefer SSM in deployed stages. */
export const OWNER_NOTIFY_RECIPIENT_ENV = 'OWNER_NOTIFY_RECIPIENT';
export const OWNER_NOTIFY_SENDER_ENV = 'OWNER_NOTIFY_SENDER';

export const OWNER_NOTIFY_EVENT_TTL_SECONDS = 90 * 24 * 60 * 60;
export const OWNER_NOTIFY_RESEND_API_URL = 'https://api.resend.com/emails';
export const OWNER_NOTIFY_RESEND_TIMEOUT_MS = 8_000;

export function ownerNotifyRecipientParamName(stage: string): string {
  return `/wardrobe/${stage.trim()}/owner-notify/recipient`;
}

export function ownerNotifySenderParamName(stage: string): string {
  return `/wardrobe/${stage.trim()}/owner-notify/sender`;
}

export function ownerNotifyResendSecretName(stage: string): string {
  return `wardrobe/${stage.trim()}/resend-api-key`;
}
