import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Resend signs webhooks with the Standard Webhooks / Svix scheme:
 * https://resend.com/docs/webhooks/verify-webhooks-requests
 *
 * Headers on the wire: svix-id, svix-timestamp, svix-signature
 * Secret: whsec_<base64>
 * Signed content: `${id}.${timestamp}.${rawBody}`
 * Signature: HMAC-SHA256, base64, listed as space-separated `v1,<sig>` tokens
 * Replay window: 5 minutes (Svix default)
 */
export const RESEND_WEBHOOK_TOLERANCE_SECONDS = 300;

export interface ResendWebhookHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

export function verifyResendWebhookSignature(options: {
  payload: string;
  headers: ResendWebhookHeaders;
  webhookSecret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): unknown {
  const { payload, headers, webhookSecret } = options;
  if (!headers.id?.trim() || !headers.timestamp?.trim() || !headers.signature?.trim()) {
    throw new Error('Missing webhook signature headers');
  }

  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp)) {
    throw new Error('Invalid webhook timestamp');
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? RESEND_WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) {
    throw new Error('Webhook timestamp outside tolerance');
  }

  const expected = createHmac('sha256', decodeWebhookSecret(webhookSecret))
    .update(`${headers.id}.${headers.timestamp}.${payload}`)
    .digest();

  let matched = false;
  for (const token of headers.signature.trim().split(/\s+/)) {
    const comma = token.indexOf(',');
    if (comma < 0) {
      continue;
    }
    const version = token.slice(0, comma);
    const signature = token.slice(comma + 1);
    if (version !== 'v1' || !signature) {
      continue;
    }

    const actual = Buffer.from(signature, 'base64');
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
      matched = true;
      break;
    }
  }

  if (!matched) {
    throw new Error('Invalid webhook signature');
  }

  try {
    return JSON.parse(payload) as unknown;
  } catch {
    throw new Error('Webhook payload must be valid JSON');
  }
}

export function decodeWebhookSecret(secret: string): Buffer {
  const trimmed = secret.trim();
  const raw = trimmed.startsWith('whsec_') ? trimmed.slice('whsec_'.length) : trimmed;
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length === 0) {
    throw new Error('Webhook secret is empty');
  }
  return decoded;
}

export function signResendWebhook(options: {
  payload: string;
  id: string;
  timestamp: string;
  webhookSecret: string;
}): string {
  const digest = createHmac('sha256', decodeWebhookSecret(options.webhookSecret))
    .update(`${options.id}.${options.timestamp}.${options.payload}`)
    .digest('base64');
  return `v1,${digest}`;
}
