import {
  decodeWebhookSecret,
  signSvixWebhook,
  SVIX_WEBHOOK_TOLERANCE_SECONDS,
  SvixWebhookHeaders,
  verifySvixWebhookSignature,
} from '../../shared/svix';

/**
 * Resend signs webhooks with the Standard Webhooks / Svix scheme.
 * Implementation lives in `src/shared/svix.ts` (shared with Superwall).
 */
export const RESEND_WEBHOOK_TOLERANCE_SECONDS = SVIX_WEBHOOK_TOLERANCE_SECONDS;

export type ResendWebhookHeaders = SvixWebhookHeaders;

export const verifyResendWebhookSignature = verifySvixWebhookSignature;
export const signResendWebhook = signSvixWebhook;
export { decodeWebhookSecret };
