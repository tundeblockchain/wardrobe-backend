import { OWNER_NOTIFY_JOB } from '../../src/shared/types';
import { StripeLookupKeys } from '../../src/shared/stripe-plans';
import { StripeSubscriptionLike } from '../../src/shared/stripe-webhook';
import { SuperwallWebhookEvent } from '../../src/shared/entitlements';

const mockPutItemIfNotExists = jest.fn();
const mockDeleteItem = jest.fn();

jest.mock('../../src/shared/dynamodb', () => {
  const actual = jest.requireActual('../../src/shared/dynamodb') as typeof import('../../src/shared/dynamodb');
  return {
    ...actual,
    putItemIfNotExists: (...args: unknown[]) => mockPutItemIfNotExists(...args),
    deleteItem: (...args: unknown[]) => mockDeleteItem(...args),
  };
});

import {
  claimOwnerNotifyEvent,
  enqueueOwnerNotify,
  formatOwnerNotifyEmail,
  loadOwnerNotifyConfig,
  mapStripeOwnerNotify,
  mapSuperwallOwnerNotify,
  OWNER_NOTIFY_QUEUE_URL_ENV,
  OWNER_NOTIFY_RECIPIENT_PARAM_ENV,
  OWNER_NOTIFY_SENDER_PARAM_ENV,
  OwnerNotifyMessage,
  parseOwnerNotifyMessage,
  resetOwnerNotifyConfigCache,
  sendOwnerNotify,
} from '../../src/shared/owner-notify';

const LOOKUP_KEYS: StripeLookupKeys = {
  basicMonthly: 'wardrobe_basic_monthly',
  premiumMonthly: 'wardrobe_premium_monthly',
  basicYearly: 'wardrobe_basic_yearly',
  premiumYearly: 'wardrobe_premium_yearly',
};

const UID = 'firebase-uid-owner';
const EVENT_ID = 'evt_test_123';
const CREATED = 1_717_000_000;

function premiumSubscription(
  overrides: Partial<StripeSubscriptionLike> = {},
): StripeSubscriptionLike {
  return {
    id: 'sub_test_123',
    status: 'active',
    customer: { id: 'cus_test_123', email: 'buyer@example.com', metadata: { uid: UID } },
    metadata: { uid: UID, tier: 'premium' },
    current_period_end: 1_762_819_200,
    items: {
      data: [
        {
          price: {
            id: 'price_premium',
            lookup_key: 'wardrobe_premium_monthly',
            unit_amount: 1500,
            currency: 'gbp',
          },
        },
      ],
    },
    ...overrides,
  };
}

function superwallEvent(
  name: string,
  data: Record<string, unknown> = {},
): SuperwallWebhookEvent {
  return {
    type: name,
    timestamp: 1_717_000_000_000,
    data: {
      id: 'sw_evt_1',
      name,
      productId: 'premium_monthly',
      store: 'APP_STORE',
      price: 9.99,
      priceInPurchasedCurrency: 7.99,
      currencyCode: 'GBP',
      purchasedAt: 1_717_000_000_000,
      userAttributes: { firebaseUid: UID, email: 'ios-user@example.com' },
      ...data,
    },
  };
}

function message(overrides: Partial<OwnerNotifyMessage> = {}): OwnerNotifyMessage {
  return {
    jobType: OWNER_NOTIFY_JOB,
    eventType: 'subscribed',
    plan: 'premium',
    platform: 'web',
    price: 15,
    currency: 'GBP',
    userEmail: 'buyer@example.com',
    userId: UID,
    eventTimestamp: '2024-05-29T16:26:40.000Z',
    provider: 'stripe',
    providerEventId: EVENT_ID,
    ...overrides,
  };
}

describe('mapStripeOwnerNotify', () => {
  it('maps checkout.session.completed to subscribed with web price and email', () => {
    const mapped = mapStripeOwnerNotify({
      type: 'checkout.session.completed',
      eventId: EVENT_ID,
      created: CREATED,
      object: {
        id: 'cs_paid',
        amount_total: 1500,
        currency: 'gbp',
        customer_details: { email: 'buyer@example.com' },
        metadata: { uid: UID },
      },
      subscription: premiumSubscription(),
      userId: UID,
      lookupKeys: LOOKUP_KEYS,
    });

    expect(mapped).toEqual(
      expect.objectContaining({
        jobType: OWNER_NOTIFY_JOB,
        eventType: 'subscribed',
        plan: 'premium',
        platform: 'web',
        price: 15,
        currency: 'GBP',
        userEmail: 'buyer@example.com',
        userId: UID,
        provider: 'stripe',
        providerEventId: EVENT_ID,
        eventTimestamp: '2024-05-29T16:26:40.000Z',
      }),
    );
  });

  it('maps a trialing checkout with no charge to trial_started', () => {
    const mapped = mapStripeOwnerNotify({
      type: 'checkout.session.completed',
      eventId: 'evt_trial',
      created: CREATED,
      object: {
        id: 'cs_trial',
        amount_total: 0,
        currency: 'gbp',
        customer_email: 'trial@example.com',
      },
      subscription: premiumSubscription({ status: 'trialing', trial_end: CREATED + 86_400 }),
      userId: UID,
      lookupKeys: LOOKUP_KEYS,
    });

    expect(mapped).toEqual(
      expect.objectContaining({
        eventType: 'trial_started',
        userEmail: 'trial@example.com',
        price: 0,
      }),
    );
  });

  it('maps customer.subscription.created to subscribed', () => {
    const mapped = mapStripeOwnerNotify({
      type: 'customer.subscription.created',
      eventId: EVENT_ID,
      created: CREATED,
      object: premiumSubscription() as unknown as Record<string, unknown>,
      subscription: premiumSubscription(),
      userId: UID,
      lookupKeys: LOOKUP_KEYS,
    });

    expect(mapped?.eventType).toBe('subscribed');
    expect(mapped?.plan).toBe('premium');
    expect(mapped?.platform).toBe('web');
  });

  it('maps a trialing subscription.created with zero price to trial_started', () => {
    const mapped = mapStripeOwnerNotify({
      type: 'customer.subscription.created',
      eventId: EVENT_ID,
      created: CREATED,
      subscription: premiumSubscription({
        status: 'trialing',
        items: {
          data: [
            {
              price: {
                id: 'price_trial',
                lookup_key: 'wardrobe_premium_monthly',
                unit_amount: 0,
                currency: 'gbp',
              },
            },
          ],
        },
      }),
      userId: UID,
      lookupKeys: LOOKUP_KEYS,
    });

    expect(mapped?.eventType).toBe('trial_started');
  });

  it('maps cancel_at_period_end flipping to true as canceled', () => {
    const mapped = mapStripeOwnerNotify({
      type: 'customer.subscription.updated',
      eventId: EVENT_ID,
      created: CREATED,
      previousAttributes: { cancel_at_period_end: false },
      subscription: premiumSubscription({ cancel_at_period_end: true }),
      userId: UID,
      lookupKeys: LOOKUP_KEYS,
    });

    expect(mapped?.eventType).toBe('canceled');
    expect(mapped?.userId).toBe(UID);
  });

  it('ignores subscription.updated when cancel_at_period_end was already true', () => {
    const mapped = mapStripeOwnerNotify({
      type: 'customer.subscription.updated',
      eventId: EVENT_ID,
      created: CREATED,
      previousAttributes: { current_period_end: 1 },
      subscription: premiumSubscription({ cancel_at_period_end: true }),
      userId: UID,
      lookupKeys: LOOKUP_KEYS,
    });

    expect(mapped).toBeUndefined();
  });

  it('maps customer.subscription.deleted after a scheduled cancel as expired', () => {
    const mapped = mapStripeOwnerNotify({
      type: 'customer.subscription.deleted',
      eventId: EVENT_ID,
      created: CREATED,
      subscription: premiumSubscription({
        status: 'canceled',
        cancel_at_period_end: true,
        ended_at: CREATED,
      }),
      userId: UID,
      lookupKeys: LOOKUP_KEYS,
    });

    expect(mapped?.eventType).toBe('expired');
  });

  it('maps an immediate customer.subscription.deleted as canceled', () => {
    const mapped = mapStripeOwnerNotify({
      type: 'customer.subscription.deleted',
      eventId: EVENT_ID,
      created: CREATED,
      subscription: premiumSubscription({ status: 'canceled', cancel_at_period_end: false }),
      userId: UID,
      lookupKeys: LOOKUP_KEYS,
    });

    expect(mapped?.eventType).toBe('canceled');
  });

  it('falls back to user ID when email is unknown', () => {
    const mapped = mapStripeOwnerNotify({
      type: 'customer.subscription.created',
      eventId: EVENT_ID,
      created: CREATED,
      subscription: premiumSubscription({
        customer: { id: 'cus_test_123', metadata: { uid: UID } },
      }),
      userId: UID,
      lookupKeys: LOOKUP_KEYS,
    });

    expect(mapped?.userEmail).toBeUndefined();
    expect(mapped?.userId).toBe(UID);
  });

  it('sends nothing for invoice.paid or missing event id', () => {
    expect(
      mapStripeOwnerNotify({
        type: 'invoice.paid',
        eventId: EVENT_ID,
        subscription: premiumSubscription(),
        lookupKeys: LOOKUP_KEYS,
      }),
    ).toBeUndefined();
    expect(
      mapStripeOwnerNotify({
        type: 'checkout.session.completed',
        object: { amount_total: 1500, currency: 'gbp' },
        lookupKeys: LOOKUP_KEYS,
      }),
    ).toBeUndefined();
  });
});

describe('mapSuperwallOwnerNotify', () => {
  it('maps initial_purchase to subscribed on ios with price and email', () => {
    const mapped = mapSuperwallOwnerNotify(superwallEvent('initial_purchase'), UID);

    expect(mapped).toEqual(
      expect.objectContaining({
        eventType: 'subscribed',
        plan: 'premium_monthly',
        platform: 'ios',
        price: 7.99,
        currency: 'GBP',
        userEmail: 'ios-user@example.com',
        userId: UID,
        provider: 'superwall',
        providerEventId: 'sw_evt_1',
      }),
    );
  });

  it('maps a Superwall trial initial_purchase to trial_started', () => {
    const mapped = mapSuperwallOwnerNotify(
      superwallEvent('initial_purchase', {
        periodType: 'TRIAL',
        price: 0,
        priceInPurchasedCurrency: 0,
      }),
      UID,
    );

    expect(mapped?.eventType).toBe('trial_started');
  });

  it('maps PLAY_STORE to android', () => {
    const mapped = mapSuperwallOwnerNotify(
      superwallEvent('initial_purchase', { store: 'PLAY_STORE' }),
      UID,
    );

    expect(mapped?.platform).toBe('android');
  });

  it('maps cancellation and expiration', () => {
    expect(mapSuperwallOwnerNotify(superwallEvent('cancellation'), UID)?.eventType).toBe(
      'canceled',
    );
    expect(mapSuperwallOwnerNotify(superwallEvent('expiration'), UID)?.eventType).toBe(
      'expired',
    );
  });

  it('falls back to user ID when Superwall email is missing', () => {
    const mapped = mapSuperwallOwnerNotify(
      superwallEvent('cancellation', { userAttributes: { firebaseUid: UID } }),
      UID,
    );

    expect(mapped?.userEmail).toBeUndefined();
    expect(mapped?.userId).toBe(UID);
  });

  it('sends nothing for renewal or missing event id', () => {
    expect(mapSuperwallOwnerNotify(superwallEvent('renewal'), UID)).toBeUndefined();
    expect(
      mapSuperwallOwnerNotify(
        superwallEvent('initial_purchase', { id: undefined }),
        UID,
      ),
    ).toBeUndefined();
  });
});

describe('formatOwnerNotifyEmail', () => {
  it('prefers user email over user ID and includes every required field', () => {
    const email = formatOwnerNotifyEmail(message());
    expect(email.subject).toBe('Wardrobe subscribed: premium (web)');
    expect(email.text).toContain('Event type: subscribed');
    expect(email.text).toContain('Plan: premium');
    expect(email.text).toContain('Platform: web');
    expect(email.text).toContain('Price: 15 GBP');
    expect(email.text).toContain('User: buyer@example.com');
    expect(email.text).toContain('Event time: 2024-05-29T16:26:40.000Z');
    expect(email.text).toContain(`Provider event ID: ${EVENT_ID}`);
    expect(email.html).toContain('Event type: subscribed');
  });

  it('uses the user ID when email is unknown', () => {
    const email = formatOwnerNotifyEmail(
      message({ userEmail: undefined, userId: UID }),
    );
    expect(email.text).toContain(`User: ${UID}`);
  });
});

describe('parseOwnerNotifyMessage', () => {
  it('round-trips a valid payload and rejects poison JSON', () => {
    const original = message();
    expect(parseOwnerNotifyMessage(JSON.stringify(original))).toEqual(original);
    expect(parseOwnerNotifyMessage('{')).toBeUndefined();
    expect(parseOwnerNotifyMessage(JSON.stringify({ jobType: 'NOPE' }))).toBeUndefined();
  });
});

describe('enqueueOwnerNotify', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('warns and skips when the queue URL is missing', async () => {
    await enqueueOwnerNotify(message(), { env: {}, log });
    expect(log.warn).toHaveBeenCalledWith(
      'Owner notify skipped; queue is not configured',
      expect.objectContaining({ providerEventId: EVENT_ID }),
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('catches SQS failures and never throws', async () => {
    const sqsSend = jest.fn().mockRejectedValue(new Error('SQS down'));
    await expect(
      enqueueOwnerNotify(message(), {
        env: { [OWNER_NOTIFY_QUEUE_URL_ENV]: 'https://sqs.example/queue' },
        sqsSend,
        log,
      }),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      'Owner notify enqueue failed',
      expect.objectContaining({ providerEventId: EVENT_ID }),
    );
  });

  it('does not log the user email when enqueue fails', async () => {
    const sqsSend = jest.fn().mockRejectedValue(new Error('SQS down'));
    await enqueueOwnerNotify(message(), {
      env: { [OWNER_NOTIFY_QUEUE_URL_ENV]: 'https://sqs.example/queue' },
      sqsSend,
      log,
    });
    const serialized = JSON.stringify(log.error.mock.calls);
    expect(serialized).not.toContain('buyer@example.com');
  });
});

describe('sendOwnerNotify', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    resetOwnerNotifyConfigCache();
    mockPutItemIfNotExists.mockResolvedValue(true);
    mockDeleteItem.mockResolvedValue(undefined);
    process.env[OWNER_NOTIFY_RECIPIENT_PARAM_ENV] =
      '/wardrobe/dev/owner-notify/recipient';
    process.env[OWNER_NOTIFY_SENDER_PARAM_ENV] = '/wardrobe/dev/owner-notify/sender';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetOwnerNotifyConfigCache();
  });

  it('sends SES on the first delivery and skips a retry with the same event ID', async () => {
    const sendEmail = jest.fn().mockResolvedValue(undefined);
    const claimEvent = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const loadConfig = async () => ({
      recipient: 'owner@example.com',
      sender: 'alerts@example.com',
    });
    await sendOwnerNotify(message(), { claimEvent, sendEmail, loadConfig, log });
    await sendOwnerNotify(message(), { claimEvent, sendEmail, loadConfig, log });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: 'alerts@example.com',
        recipient: 'owner@example.com',
        subject: 'Wardrobe subscribed: premium (web)',
      }),
    );
    expect(log.info).toHaveBeenCalledWith(
      'Owner notify skipped; event already sent',
      expect.objectContaining({ providerEventId: EVENT_ID }),
    );
  });

  it('uses Dynamo conditional put keyed by provider event ID', async () => {
    await claimOwnerNotifyEvent(message(), { nowSeconds: 1_700_000_000, ttlSeconds: 60 });
    expect(mockPutItemIfNotExists).toHaveBeenCalledWith(
      expect.objectContaining({
        PK: `NOTIFY#stripe#${EVENT_ID}`,
        SK: 'SENT',
        entityType: 'OWNER_NOTIFY',
        ttl: 1_700_000_060,
      }),
    );
  });

  it('skips quietly when SSM config is missing', async () => {
    const sendEmail = jest.fn();
    const forgetEvent = jest.fn().mockResolvedValue(undefined);
    await sendOwnerNotify(message(), {
      claimEvent: async () => true,
      forgetEvent,
      loadConfig: async () => undefined,
      sendEmail,
      log,
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(forgetEvent).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('loadOwnerNotifyConfig warns and skips invalid or missing addresses', async () => {
    const config = await loadOwnerNotifyConfig({
      env: {
        [OWNER_NOTIFY_RECIPIENT_PARAM_ENV]: '/wardrobe/dev/owner-notify/recipient',
        [OWNER_NOTIFY_SENDER_PARAM_ENV]: '/wardrobe/dev/owner-notify/sender',
      },
      getParameter: async () => 'not-an-email',
      log,
    });
    expect(config).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      'Owner notify skipped; sender or recipient is missing or invalid',
    );
  });

  it('releases the dedupe claim and rethrows when SES fails', async () => {
    const forgetEvent = jest.fn().mockResolvedValue(undefined);
    const sendEmail = jest.fn().mockRejectedValue(new Error('SES throttled'));
    await expect(
      sendOwnerNotify(message(), {
        claimEvent: async () => true,
        forgetEvent,
        loadConfig: async () => ({
          recipient: 'owner@example.com',
          sender: 'alerts@example.com',
        }),
        sendEmail,
        log,
      }),
    ).rejects.toThrow('SES throttled');
    expect(forgetEvent).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      'Owner notify SES send failed',
      expect.objectContaining({ providerEventId: EVENT_ID }),
    );
    const serialized = JSON.stringify(log.error.mock.calls);
    expect(serialized).not.toContain('buyer@example.com');
    expect(serialized).not.toContain('owner@example.com');
  });
});
