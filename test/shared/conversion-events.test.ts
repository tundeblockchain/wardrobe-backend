import { createHash } from 'crypto';
import {
  CONVERSION_EVENT_RENEWED,
  CONVERSION_EVENT_START_TRIAL,
  CONVERSION_EVENT_SUBSCRIBE,
  hashExternalId,
  mapStripeConversionEvent,
  mapSuperwallConversionEvent,
  stripeCheckoutEventId,
  stripeInvoiceEventId,
  stripeMinorToMajor,
  superwallConversionEventId,
  superwallIsTrialStart,
} from '../../src/shared/conversion-events';
import { SuperwallWebhookEvent } from '../../src/shared/entitlements';

const UID = 'firebase-uid-owner';
const HASHED = createHash('sha256').update(UID, 'utf8').digest('hex');
const EVENT_TIME = 1_717_000_000;

function assertNoPii(value: unknown, rawUid = UID): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(rawUid);
  expect(serialized).not.toMatch(/@/);
  expect(serialized.toLowerCase()).not.toContain('phone');
  expect(serialized.toLowerCase()).not.toContain('email');
  expect(serialized).not.toContain('Jane');
  expect(serialized).not.toContain('Doe');
}

describe('conversion event ids (WARDROBE-249)', () => {
  it('formats Stripe checkout, Stripe invoice, and Superwall store transaction ids', () => {
    expect(stripeCheckoutEventId('cs_test_abc')).toBe('stripe_cs_test_abc');
    expect(stripeInvoiceEventId('in_test_abc')).toBe('stripe_in_test_abc');
    expect(superwallConversionEventId('700002054157982')).toBe(
      'sw_700002054157982',
    );
  });

  it('hashes the Firebase uid as SHA-256 hex and does not emit the raw id', () => {
    expect(hashExternalId(UID)).toBe(HASHED);
    expect(HASHED).toHaveLength(64);
    expect(HASHED).toMatch(/^[a-f0-9]{64}$/);
    expect(HASHED).not.toContain(UID);
  });

  it('converts Stripe minor units except for zero-decimal currencies', () => {
    expect(stripeMinorToMajor(1999, 'gbp')).toBe(19.99);
    expect(stripeMinorToMajor(1500, 'USD')).toBe(15);
    expect(stripeMinorToMajor(500, 'jpy')).toBe(500);
  });
});

describe('mapStripeConversionEvent', () => {
  const paidSubscription = {
    id: 'sub_1',
    status: 'active',
    trial_end: null as number | null,
  };

  it('maps checkout.session.completed on an active subscription to Subscribe', () => {
    const event = mapStripeConversionEvent({
      type: 'checkout.session.completed',
      object: {
        id: 'cs_test_1',
        amount_total: 1500,
        currency: 'gbp',
        customer: 'cus_1',
      },
      userId: UID,
      subscription: paidSubscription,
      eventTimeSeconds: EVENT_TIME,
    });

    expect(event).toEqual({
      eventName: CONVERSION_EVENT_SUBSCRIBE,
      eventId: 'stripe_cs_test_1',
      eventTimeSeconds: EVENT_TIME,
      actionSource: 'system_generated',
      externalId: HASHED,
      value: 15,
      currency: 'GBP',
    });
    assertNoPii(event);
  });

  it('maps checkout.session.completed with status trialing to StartTrial', () => {
    const event = mapStripeConversionEvent({
      type: 'checkout.session.completed',
      object: { id: 'cs_trial', amount_total: 0, currency: 'usd' },
      userId: UID,
      subscription: { status: 'trialing', trial_end: EVENT_TIME + 86_400 },
      eventTimeSeconds: EVENT_TIME,
    });

    expect(event?.eventName).toBe(CONVERSION_EVENT_START_TRIAL);
    expect(event?.eventId).toBe('stripe_cs_trial');
    expect(event?.value).toBe(0);
    expect(event?.currency).toBe('USD');
  });

  it('maps a trialing checkout with a charge to Subscribe, not StartTrial', () => {
    const event = mapStripeConversionEvent({
      type: 'checkout.session.completed',
      object: { id: 'cs_paid_trial', amount_total: 1500, currency: 'gbp' },
      userId: UID,
      subscription: { status: 'trialing', trial_end: EVENT_TIME + 86_400 },
      eventTimeSeconds: EVENT_TIME,
    });
    expect(event?.eventName).toBe(CONVERSION_EVENT_SUBSCRIBE);
  });

  it('does not treat an active subscription with a future trial_end as StartTrial', () => {
    const event = mapStripeConversionEvent({
      type: 'checkout.session.completed',
      object: { id: 'cs_trial_end', amount_total: 1500, currency: 'gbp' },
      userId: UID,
      subscription: { status: 'active', trial_end: EVENT_TIME + 10 },
      eventTimeSeconds: EVENT_TIME,
    });
    expect(event?.eventName).toBe(CONVERSION_EVENT_SUBSCRIBE);
  });

  it('maps the first paid invoice after a trial to Subscribe', () => {
    const trialEnd = EVENT_TIME;
    const event = mapStripeConversionEvent({
      type: 'invoice.paid',
      object: {
        id: 'in_trial_convert',
        billing_reason: 'subscription_cycle',
        amount_paid: 1500,
        currency: 'gbp',
        customer: 'cus_1',
        period_start: trialEnd,
        subscription: 'sub_1',
      },
      userId: UID,
      subscription: {
        id: 'sub_1',
        status: 'active',
        trial_end: trialEnd,
        current_period_start: trialEnd,
      },
      eventTimeSeconds: EVENT_TIME,
    });

    expect(event).toEqual({
      eventName: CONVERSION_EVENT_SUBSCRIBE,
      eventId: 'stripe_in_trial_convert',
      eventTimeSeconds: EVENT_TIME,
      actionSource: 'system_generated',
      externalId: HASHED,
      value: 15,
      currency: 'GBP',
    });
    assertNoPii(event);
  });

  it('maps invoice.paid subscription_cycle to SubscriptionRenewed', () => {
    const event = mapStripeConversionEvent({
      type: 'invoice.paid',
      object: {
        id: 'in_renew_1',
        billing_reason: 'subscription_cycle',
        amount_paid: 999,
        currency: 'usd',
        customer: 'cus_1',
      },
      userId: UID,
      eventTimeSeconds: EVENT_TIME,
    });

    expect(event).toEqual({
      eventName: CONVERSION_EVENT_RENEWED,
      eventId: 'stripe_in_renew_1',
      eventTimeSeconds: EVENT_TIME,
      actionSource: 'system_generated',
      externalId: HASHED,
      value: 9.99,
      currency: 'USD',
    });
    assertNoPii(event);
  });

  it.each([
    'subscription_create',
    'subscription_update',
    'manual',
    'upcoming',
  ])('sends nothing for invoice.paid billing_reason %s', (billingReason) => {
    expect(
      mapStripeConversionEvent({
        type: 'invoice.paid',
        object: {
          id: 'in_other',
          billing_reason: billingReason,
          amount_paid: 1500,
          currency: 'usd',
        },
        userId: UID,
        eventTimeSeconds: EVENT_TIME,
      }),
    ).toBeUndefined();
  });

  it.each([
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'charge.refunded',
    'invoice.updated',
  ])('sends nothing for Stripe event type %s', (type) => {
    expect(
      mapStripeConversionEvent({
        type,
        object: { id: 'obj_1', customer: 'cus_1' },
        userId: UID,
        subscription: paidSubscription,
        eventTimeSeconds: EVENT_TIME,
      }),
    ).toBeUndefined();
  });

  it('sends nothing without a Firebase uid or checkout session id', () => {
    expect(
      mapStripeConversionEvent({
        type: 'checkout.session.completed',
        object: { id: 'cs_1' },
        userId: undefined,
        eventTimeSeconds: EVENT_TIME,
      }),
    ).toBeUndefined();
    expect(
      mapStripeConversionEvent({
        type: 'checkout.session.completed',
        object: { amount_total: 100 },
        userId: UID,
        subscription: paidSubscription,
        eventTimeSeconds: EVENT_TIME,
      }),
    ).toBeUndefined();
  });

  it('is idempotent: the same checkout session always yields the same event_id', () => {
    const first = mapStripeConversionEvent({
      type: 'checkout.session.completed',
      object: { id: 'cs_same' },
      userId: UID,
      subscription: paidSubscription,
      eventTimeSeconds: EVENT_TIME,
    });
    const second = mapStripeConversionEvent({
      type: 'checkout.session.completed',
      object: { id: 'cs_same' },
      userId: UID,
      subscription: paidSubscription,
      eventTimeSeconds: EVENT_TIME + 50,
    });
    expect(first?.eventId).toBe('stripe_cs_same');
    expect(second?.eventId).toBe(first?.eventId);
  });
});

describe('mapSuperwallConversionEvent', () => {
  function event(
    name: string,
    data: Record<string, unknown> = {},
  ): SuperwallWebhookEvent {
    return {
      type: name,
      data: {
        name,
        transactionId: '700002054157982',
        originalTransactionId: '700002050981465',
        periodType: 'NORMAL',
        isTrialConversion: false,
        price: 9.99,
        priceInPurchasedCurrency: 7.99,
        currencyCode: 'GBP',
        purchasedAt: EVENT_TIME * 1000,
        ...data,
      },
    };
  }

  it('maps initial_purchase to Subscribe with sw_<transaction_id>', () => {
    const mapped = mapSuperwallConversionEvent(event('initial_purchase'), UID);
    expect(mapped).toEqual({
      eventName: CONVERSION_EVENT_SUBSCRIBE,
      eventId: 'sw_700002054157982',
      eventTimeSeconds: EVENT_TIME,
      actionSource: 'app',
      externalId: HASHED,
      value: 7.99,
      currency: 'GBP',
    });
    assertNoPii(mapped);
  });

  it('maps a trial periodType to StartTrial', () => {
    const mapped = mapSuperwallConversionEvent(
      event('initial_purchase', { periodType: 'TRIAL', price: 0, priceInPurchasedCurrency: 0 }),
      UID,
    );
    expect(mapped?.eventName).toBe(CONVERSION_EVENT_START_TRIAL);
    expect(mapped?.eventId).toBe('sw_700002054157982');
    expect(superwallIsTrialStart({ periodType: 'TRIAL' })).toBe(true);
  });

  it('maps a free intro offer (price 0) to StartTrial', () => {
    expect(
      mapSuperwallConversionEvent(
        event('initial_purchase', {
          periodType: 'INTRO',
          price: 0,
          priceInPurchasedCurrency: 0,
        }),
        UID,
      )?.eventName,
    ).toBe(CONVERSION_EVENT_START_TRIAL);
    expect(
      superwallIsTrialStart({ period_type: 'intro', price: 0 }),
    ).toBe(true);
  });

  it('maps a paid intro offer (price > 0) to Subscribe', () => {
    expect(
      mapSuperwallConversionEvent(
        event('initial_purchase', { periodType: 'INTRO' }),
        UID,
      )?.eventName,
    ).toBe(CONVERSION_EVENT_SUBSCRIBE);
    expect(superwallIsTrialStart({ periodType: 'INTRO', price: 7.99 })).toBe(
      false,
    );
  });

  it('maps a Superwall trial conversion renewal to Subscribe', () => {
    const mapped = mapSuperwallConversionEvent(
      event('renewal', {
        transactionId: '700008888001',
        isTrialConversion: true,
        periodType: 'NORMAL',
      }),
      UID,
    );
    expect(mapped?.eventName).toBe(CONVERSION_EVENT_SUBSCRIBE);
    expect(mapped?.eventId).toBe('sw_700008888001');
  });

  it('maps renewal to SubscriptionRenewed using the new store transaction id', () => {
    const mapped = mapSuperwallConversionEvent(
      event('renewal', { transactionId: '700009999999' }),
      UID,
    );
    expect(mapped?.eventName).toBe(CONVERSION_EVENT_RENEWED);
    expect(mapped?.eventId).toBe('sw_700009999999');
  });

  it.each([
    'cancellation',
    'uncancellation',
    'expiration',
    'billing_issue',
    'restore',
    'refund',
    'product_change',
    'non_renewing_purchase',
    'subscription_paused',
  ])('sends nothing for Superwall %s', (name) => {
    expect(mapSuperwallConversionEvent(event(name), UID)).toBeUndefined();
  });

  it('sends nothing without a store transaction id (never generates a random id)', () => {
    expect(
      mapSuperwallConversionEvent(
        event('initial_purchase', { transactionId: undefined }),
        UID,
      ),
    ).toBeUndefined();
  });

  it('is idempotent across duplicate deliveries of the same transaction id', () => {
    const first = mapSuperwallConversionEvent(event('initial_purchase'), UID);
    const second = mapSuperwallConversionEvent(event('initial_purchase'), UID);
    expect(first?.eventId).toBe(second?.eventId);
    expect(first?.eventId).toBe('sw_700002054157982');
  });
});
