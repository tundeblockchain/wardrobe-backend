import { createHmac } from 'crypto';
import {
  decodeWebhookSecret,
  signResendWebhook,
  verifyResendWebhookSignature,
} from '../../src/functions/support/webhook-verify';

const SECRET = `whsec_${Buffer.from('unit-test-webhook-secret').toString('base64')}`;
const PAYLOAD = JSON.stringify({
  type: 'email.received',
  data: { email_id: '11111111-1111-1111-1111-111111111111' },
});
const ID = 'msg_test_webhook';
const TIMESTAMP = '1710000000';

describe('Resend Svix webhook verification (WARDROBE-38)', () => {
  const signature = signResendWebhook({
    payload: PAYLOAD,
    id: ID,
    timestamp: TIMESTAMP,
    webhookSecret: SECRET,
  });

  it('accepts a valid v1 HMAC over id.timestamp.rawBody', () => {
    const event = verifyResendWebhookSignature({
      payload: PAYLOAD,
      headers: { id: ID, timestamp: TIMESTAMP, signature },
      webhookSecret: SECRET,
      nowSeconds: Number(TIMESTAMP),
    });

    expect(event).toEqual(JSON.parse(PAYLOAD));
  });

  it('accepts any matching v1 token when the header lists several', () => {
    const other = `v1,${createHmac('sha256', decodeWebhookSecret(SECRET))
      .update('other')
      .digest('base64')}`;

    expect(
      verifyResendWebhookSignature({
        payload: PAYLOAD,
        headers: {
          id: ID,
          timestamp: TIMESTAMP,
          signature: `${other} ${signature}`,
        },
        webhookSecret: SECRET,
        nowSeconds: Number(TIMESTAMP),
      }),
    ).toEqual(JSON.parse(PAYLOAD));
  });

  it('rejects a tampered body (raw payload must be used)', () => {
    expect(() =>
      verifyResendWebhookSignature({
        payload: JSON.stringify({ type: 'email.received', extra: true }),
        headers: { id: ID, timestamp: TIMESTAMP, signature },
        webhookSecret: SECRET,
        nowSeconds: Number(TIMESTAMP),
      }),
    ).toThrow('Invalid webhook signature');
  });

  it('rejects an unknown secret', () => {
    expect(() =>
      verifyResendWebhookSignature({
        payload: PAYLOAD,
        headers: { id: ID, timestamp: TIMESTAMP, signature },
        webhookSecret: `whsec_${Buffer.from('different-secret').toString('base64')}`,
        nowSeconds: Number(TIMESTAMP),
      }),
    ).toThrow('Invalid webhook signature');
  });

  it('rejects timestamps outside the 5-minute replay window', () => {
    expect(() =>
      verifyResendWebhookSignature({
        payload: PAYLOAD,
        headers: { id: ID, timestamp: TIMESTAMP, signature },
        webhookSecret: SECRET,
        nowSeconds: Number(TIMESTAMP) + 301,
      }),
    ).toThrow('Webhook timestamp outside tolerance');
  });

  it('rejects missing headers', () => {
    expect(() =>
      verifyResendWebhookSignature({
        payload: PAYLOAD,
        headers: { id: '', timestamp: TIMESTAMP, signature },
        webhookSecret: SECRET,
        nowSeconds: Number(TIMESTAMP),
      }),
    ).toThrow('Missing webhook signature headers');
  });
});
