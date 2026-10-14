import Stripe from 'stripe';
import {
  currentPeriodEndIso,
  isStripeClearStatus,
  isStripeGrantStatus,
  paidTierFromStripeSubscription,
  rawWebhookPayload,
  stripeSignatureHeader,
  subscriptionIdFromStripeEvent,
  verifyStripeWebhookSignature,
} from '../../src/shared/stripe-webhook';

const SECRET = 'whsec_unit_test_secret';

describe('stripe webhook helpers (WARDROBE-190)', () => {
  it('base64-decodes API Gateway bodies to raw bytes before verify', () => {
    const payload = '{"id":"evt_1","object":"event"}';
    const event = {
      body: Buffer.from(payload, 'utf8').toString('base64'),
      isBase64Encoded: true,
      headers: {},
    } as unknown as Parameters<typeof rawWebhookPayload>[0];

    const decoded = rawWebhookPayload(event);
    expect(Buffer.isBuffer(decoded)).toBe(true);
    expect(decoded.equals(Buffer.from(payload, 'utf8'))).toBe(true);
    expect(decoded.toString('utf8')).toBe(payload);
  });

  it('verifies Stripe-Signature against decoded bytes and rejects bad signatures before JSON.parse', () => {
    const payload = JSON.stringify({
      id: 'evt_verify',
      object: 'event',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1' } },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: SECRET,
    });
    const parse = jest.spyOn(JSON, 'parse');

    expect(() =>
      verifyStripeWebhookSignature({
        payload: Buffer.from(payload, 'utf8'),
        signature: 't=1,v1=nope',
        webhookSecret: SECRET,
      }),
    ).toThrow('Invalid Stripe webhook signature.');
    expect(parse).not.toHaveBeenCalled();

    parse.mockClear();
    const verified = verifyStripeWebhookSignature({
      payload: Buffer.from(payload, 'utf8'),
      signature,
      webhookSecret: SECRET,
    });
    expect(verified.id).toBe('evt_verify');
    parse.mockRestore();
  });

  it('reads Stripe-Signature case-insensitively', () => {
    expect(
      stripeSignatureHeader({
        headers: { 'Stripe-Signature': 't=1,v1=abc' },
      } as unknown as Parameters<typeof stripeSignatureHeader>[0]),
    ).toBe('t=1,v1=abc');
  });

  it('extracts the subscription id from checkout.session.completed', () => {
    expect(
      subscriptionIdFromStripeEvent({
        type: 'checkout.session.completed',
        data: { object: { subscription: 'sub_from_session' } },
      }),
    ).toBe('sub_from_session');
  });

  it('maps lookup keys and subscription status', () => {
    const keys = {
      basicMonthly: 'wardrobe_basic_monthly',
      premiumMonthly: 'wardrobe_premium_monthly',
      basicYearly: 'wardrobe_basic_yearly',
      premiumYearly: 'wardrobe_premium_yearly',
    };
    expect(
      paidTierFromStripeSubscription(
        {
          items: {
            data: [{ price: { lookup_key: 'wardrobe_basic_monthly' } }],
          },
        },
        keys,
      ),
    ).toBe('basic');
    expect(
      paidTierFromStripeSubscription(
        {
          items: {
            data: [{ price: { lookup_key: 'wardrobe_basic_yearly' } }],
          },
        },
        keys,
      ),
    ).toBe('basic');
    expect(
      paidTierFromStripeSubscription(
        {
          items: {
            data: [{ price: { lookup_key: 'wardrobe_premium_yearly' } }],
          },
        },
        keys,
      ),
    ).toBe('premium');
    expect(
      paidTierFromStripeSubscription(
        {
          items: {
            data: [{ price: { id: 'price_yearly_basic' } }],
          },
        },
        keys,
        { basicYearly: 'price_yearly_basic' },
      ),
    ).toBe('basic');
    expect(isStripeGrantStatus({ status: 'trialing' })).toBe(true);
    expect(isStripeGrantStatus({ status: 'past_due' })).toBe(true);
    expect(isStripeClearStatus({ status: 'past_due' })).toBe(false);
    expect(isStripeClearStatus({ status: 'canceled' })).toBe(true);
    expect(isStripeClearStatus({ status: 'unpaid' })).toBe(true);
    expect(isStripeClearStatus({ status: 'incomplete_expired' })).toBe(true);
    expect(isStripeClearStatus({ ended_at: 1_700_000_000 })).toBe(true);
    expect(currentPeriodEndIso({ current_period_end: 1_700_000_000 })).toBe(
      new Date(1_700_000_000 * 1000).toISOString(),
    );
  });
});
