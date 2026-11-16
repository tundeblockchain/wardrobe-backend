import { OWNER_NOTIFY_JOB } from '../../src/shared/types';
import { StripeLookupKeys } from '../../src/shared/stripe-plans';
import { StripeSubscriptionLike } from '../../src/shared/stripe-webhook';
import { SuperwallWebhookEvent } from '../../src/shared/entitlements';
import * as fs from 'fs';
import * as path from 'path';
import {
  formatOwnerNotifyEmail,
  mapStripeOwnerNotify,
  mapSuperwallOwnerNotify,
  ownerNotifyFailureFields,
  OwnerNotifyMessage,
  parseOwnerNotifyMessage,
  safeErrorMessage,
  STRIPE_OWNER_NOTIFY_EVENTS,
  SUPERWALL_OWNER_NOTIFY_EVENTS,
} from '../../src/shared/owner-notify';
import {
  loadOwnerNotifyApiKey,
  loadOwnerNotifyConfig,
  notifyOwnerBestEffort,
  OWNER_NOTIFY_AWS_CLIENT_CONFIG,
  OWNER_NOTIFY_AWS_MAX_ATTEMPTS,
  OWNER_NOTIFY_AWS_REQUEST_TIMEOUT_MS,
  OWNER_NOTIFY_RECIPIENT_ENV,
  OWNER_NOTIFY_RECIPIENT_PARAM_ENV,
  OWNER_NOTIFY_SENDER_ENV,
  RESEND_SECRET_ARN_ENV,
  resetOwnerNotifyConfigCache,
  sendOwnerNotify,
} from '../../src/shared/owner-notify-send';
import { RESEND_API_BASE } from '../../src/shared/resend';
import { SUPPORT_FROM_EMAIL_ENV } from '../../src/shared/owner-notify-names';

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
    customer: { id: 'cus_test_123', email: 'owner@example.com', metadata: { uid: UID } },
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
      userAttributes: { firebaseUid: UID, email: 'owner@example.com' },
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
    userEmail: 'owner@example.com',
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
        customer_details: { email: 'owner@example.com' },
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
        userEmail: 'owner@example.com',
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
        customer_email: 'owner@example.com',
      },
      subscription: premiumSubscription({ status: 'trialing', trial_end: CREATED + 86_400 }),
      userId: UID,
      lookupKeys: LOOKUP_KEYS,
    });

    expect(mapped).toEqual(
      expect.objectContaining({
        eventType: 'trial_started',
        userEmail: 'owner@example.com',
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

  it('sends nothing when subscription.updated has status canceled without a cancel_at_period_end flip', () => {
    expect(
      mapStripeOwnerNotify({
        type: 'customer.subscription.updated',
        eventId: EVENT_ID,
        created: CREATED,
        previousAttributes: { status: 'active' },
        subscription: premiumSubscription({
          status: 'canceled',
          cancel_at_period_end: false,
        }),
        lookupKeys: LOOKUP_KEYS,
      }),
    ).toBeUndefined();
  });

  it.each([
    'invoice.paid',
    'invoice.payment_succeeded',
    'customer.updated',
    'charge.succeeded',
    'customer.subscription.paused',
  ])('sends nothing for unmapped Stripe type %s', (type) => {
    expect(
      mapStripeOwnerNotify({
        type,
        eventId: EVENT_ID,
        subscription: premiumSubscription(),
        lookupKeys: LOOKUP_KEYS,
      }),
    ).toBeUndefined();
  });

  it('sends nothing when the Stripe event id is missing', () => {
    expect(
      mapStripeOwnerNotify({
        type: 'checkout.session.completed',
        object: { amount_total: 1500, currency: 'gbp' },
        lookupKeys: LOOKUP_KEYS,
      }),
    ).toBeUndefined();
  });
});

describe('owner notify mapping tables', () => {
  it('lists the Stripe types that send an owner email', () => {
    expect(Object.keys(STRIPE_OWNER_NOTIFY_EVENTS).sort()).toEqual([
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.deleted',
      'customer.subscription.updated',
    ]);
  });

  it('lists the Superwall names that send an owner email', () => {
    expect(Object.keys(SUPERWALL_OWNER_NOTIFY_EVENTS).sort()).toEqual([
      'cancellation',
      'expiration',
      'initial_purchase',
    ]);
  });

  it('keeps Resend and SES out of the webhook mapping module', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/shared/owner-notify.ts'),
      'utf8',
    );
    expect(source).not.toContain('@aws-sdk/client-ses');
    expect(source).not.toContain('@aws-sdk/client-ssm');
    expect(source).not.toContain('@aws-sdk/client-sqs');
    expect(source).not.toContain('api.resend.com');
    expect(source).not.toContain('SendEmail');
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
        userEmail: 'owner@example.com',
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

  it('maps cancellation to canceled', () => {
    expect(mapSuperwallOwnerNotify(superwallEvent('cancellation'), UID)?.eventType).toBe(
      'canceled',
    );
  });

  it('maps expiration to expired', () => {
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

  it.each([
    'renewal',
    'product_change',
    'billing_issue',
    'uncancellation',
    'subscription_paused',
  ])('sends nothing for unmapped Superwall type %s', (name) => {
    expect(mapSuperwallOwnerNotify(superwallEvent(name), UID)).toBeUndefined();
  });

  it('sends nothing when the Superwall event id is missing', () => {
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
    expect(email.text).toContain('User: owner@example.com');
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

describe('safeErrorMessage', () => {
  it('redacts Bearer tokens and email addresses', () => {
    expect(
      safeErrorMessage(
        new Error('Authorization: Bearer placeholder owner@example.com failed'),
      ),
    ).toBe('Authorization: Bearer [redacted] [redacted] failed');
  });
});

describe('ownerNotifyFailureFields', () => {
  it('logs event ID plus error class and status only', () => {
    expect(
      ownerNotifyFailureFields(
        EVENT_ID,
        Object.assign(new Error('Resend send HTTP 500'), { status: 500 }),
      ),
    ).toEqual({
      providerEventId: EVENT_ID,
      error: 'ResendHttpError',
      status: 500,
    });
    expect(ownerNotifyFailureFields(EVENT_ID, new Error('Resend send timed out'))).toEqual({
      providerEventId: EVENT_ID,
      error: 'Timeout',
    });
    const serialized = JSON.stringify(
      ownerNotifyFailureFields(
        EVENT_ID,
        new Error('Bearer placeholder owner@example.com failed'),
      ),
    );
    expect(serialized).not.toContain('placeholder');
    expect(serialized).not.toContain('owner@example.com');
    expect(serialized).not.toContain('Bearer');
  });
});

describe('notifyOwnerBestEffort', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('swallows notifyOwner failures and never throws', async () => {
    const notifyOwner = jest.fn().mockRejectedValue(new Error('Resend down'));
    await expect(
      notifyOwnerBestEffort(message(), { notifyOwner, log }),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith('Owner notify failed', {
      providerEventId: EVENT_ID,
      error: 'Error',
    });
    const serialized = JSON.stringify(log.error.mock.calls);
    expect(serialized).not.toContain('owner@example.com');
    expect(serialized).not.toContain('Resend down');
  });

  it('does nothing when the mapped message is undefined', async () => {
    const notifyOwner = jest.fn();
    await notifyOwnerBestEffort(undefined, { notifyOwner, log });
    expect(notifyOwner).not.toHaveBeenCalled();
  });
});

describe('sendOwnerNotify', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    resetOwnerNotifyConfigCache();
    delete process.env.OWNER_NOTIFY_RECIPIENT;
    delete process.env.OWNER_NOTIFY_SENDER;
    delete process.env.OWNER_NOTIFY_RECIPIENT_PARAM;
    delete process.env.SUPPORT_FROM_EMAIL;
    delete process.env.RESEND_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetOwnerNotifyConfigCache();
  });

  function okHttp(status = 200) {
    return jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify({ id: 'email_test' }),
    });
  }

  function failHttp(status: number) {
    return jest.fn().mockResolvedValue({
      ok: false,
      status,
      text: async () => '{"message":"failed"}',
    });
  }

  function hangingHttp() {
    return jest.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const abort = () => {
          reject(
            Object.assign(new Error('The operation was aborted'), {
              name: 'AbortError',
            }),
          );
        };
        if (init?.signal?.aborted) {
          abort();
          return;
        }
        init?.signal?.addEventListener('abort', abort, { once: true });
      });
    });
  }

  it('sends via mocked HTTP on success', async () => {
    const http = okHttp();
    await sendOwnerNotify(message(), {
      loadConfig: async () => ({
        recipient: 'owner@example.com',
        sender: 'sender@example.com',
      }),
      loadApiKey: async () => 'placeholder',
      http,
      log,
    });
    expect(http).toHaveBeenCalledTimes(1);
    expect(http.mock.calls[0][0]).toBe(`${RESEND_API_BASE}/emails`);
    expect(http.mock.calls[0][1].headers['Idempotency-Key']).toBe(EVENT_ID);
    expect(log.info).toHaveBeenCalledWith(
      'Owner notify sent',
      expect.objectContaining({ providerEventId: EVENT_ID }),
    );
    const serialized = JSON.stringify(log.info.mock.calls);
    expect(serialized).not.toContain('placeholder');
    expect(serialized).not.toContain('owner@example.com');
  });

  it('never throws when Resend returns an error status', async () => {
    const http = failHttp(500);
    await expect(
      sendOwnerNotify(message(), {
        loadConfig: async () => ({
          recipient: 'owner@example.com',
          sender: 'sender@example.com',
        }),
        loadApiKey: async () => 'placeholder',
        http,
        log,
      }),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith('Owner notify Resend send failed', {
      providerEventId: EVENT_ID,
      error: 'ResendHttpError',
      status: 500,
    });
    const serialized = JSON.stringify(log.error.mock.calls);
    expect(serialized).not.toContain('placeholder');
    expect(serialized).not.toContain('owner@example.com');
    expect(Object.keys(log.error.mock.calls[0][1]).sort()).toEqual([
      'error',
      'providerEventId',
      'status',
    ]);
  });

  it('times out hanging HTTP without throwing', async () => {
    const http = hangingHttp();
    await expect(
      sendOwnerNotify(message(), {
        loadConfig: async () => ({
          recipient: 'owner@example.com',
          sender: 'sender@example.com',
        }),
        loadApiKey: async () => 'placeholder',
        http,
        timeoutMs: 20,
        log,
      }),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith('Owner notify Resend send failed', {
      providerEventId: EVENT_ID,
      error: 'Timeout',
    });
  });

  it('skips quietly when config is missing', async () => {
    const http = jest.fn();
    await sendOwnerNotify(message(), {
      env: {},
      http,
      log,
    });
    expect(http).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Owner notify skipped; sender or recipient is not configured',
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('reads sender and recipient from env without calling SSM or Secrets Manager', async () => {
    const getSecret = jest.fn();
    const getParameter = jest.fn();
    const config = await loadOwnerNotifyConfig({
      env: {
        [OWNER_NOTIFY_RECIPIENT_ENV]: 'owner@example.com',
        [OWNER_NOTIFY_SENDER_ENV]: 'sender@example.com',
      },
      getSecret,
      getParameter,
      log,
    });
    expect(config).toEqual({
      recipient: 'owner@example.com',
      sender: 'sender@example.com',
    });
    expect(getSecret).not.toHaveBeenCalled();
    expect(getParameter).not.toHaveBeenCalled();
  });

  it('reads the recipient from the SSM parameter when env override is absent', async () => {
    const getParameter = jest.fn().mockResolvedValue('owner@example.com');
    const config = await loadOwnerNotifyConfig({
      env: {
        [OWNER_NOTIFY_RECIPIENT_PARAM_ENV]: '/wardrobe/dev/owner-notify/recipient',
        [SUPPORT_FROM_EMAIL_ENV]: 'sender@example.com',
      },
      getParameter,
      log,
    });
    expect(config).toEqual({
      recipient: 'owner@example.com',
      sender: 'sender@example.com',
    });
    expect(getParameter).toHaveBeenCalledWith(
      '/wardrobe/dev/owner-notify/recipient',
    );
  });

  it('bounds SSM and Secrets Manager reads so a cold start cannot hang the webhook', () => {
    expect(OWNER_NOTIFY_AWS_MAX_ATTEMPTS).toBe(1);
    expect(OWNER_NOTIFY_AWS_REQUEST_TIMEOUT_MS).toBe(1_000);
    expect(OWNER_NOTIFY_AWS_CLIENT_CONFIG).toEqual({
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: 1_000,
        requestTimeout: 1_000,
        throwOnRequestTimeout: true,
      },
    });
  });

  it('warns and skips when the recipient parameter is missing', async () => {
    const getParameter = jest.fn().mockResolvedValue(undefined);
    const config = await loadOwnerNotifyConfig({
      env: {
        [OWNER_NOTIFY_RECIPIENT_PARAM_ENV]: '/wardrobe/dev/owner-notify/recipient',
        [SUPPORT_FROM_EMAIL_ENV]: 'sender@example.com',
      },
      getParameter,
      log,
    });
    expect(config).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      'Owner notify skipped; sender or recipient is missing or invalid',
    );
  });

  it('warns and skips when the recipient parameter read times out', async () => {
    const getParameter = jest.fn().mockRejectedValue(
      Object.assign(new Error('Timeout'), { name: 'TimeoutError' }),
    );
    const config = await loadOwnerNotifyConfig({
      env: {
        [OWNER_NOTIFY_RECIPIENT_PARAM_ENV]: '/wardrobe/dev/owner-notify/recipient',
        [SUPPORT_FROM_EMAIL_ENV]: 'sender@example.com',
      },
      getParameter,
      log,
    });
    expect(config).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      'Owner notify skipped; failed to read recipient parameter',
      { error: 'TimeoutError' },
    );
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('owner@example.com');
  });

  it('warns and skips when env and SSM config are both missing', async () => {
    const config = await loadOwnerNotifyConfig({ env: {}, log });
    expect(config).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      'Owner notify skipped; sender or recipient is not configured',
    );
  });

  it('warns and skips when the Resend secret is missing', async () => {
    const http = jest.fn();
    await sendOwnerNotify(message(), {
      loadConfig: async () => ({
        recipient: 'owner@example.com',
        sender: 'sender@example.com',
      }),
      loadApiKey: async () => undefined,
      http,
      log,
    });
    expect(http).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Owner notify skipped; Resend secret is missing or invalid',
      expect.objectContaining({ providerEventId: EVENT_ID }),
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('loadOwnerNotifyApiKey warns when the secret ARN is not configured', async () => {
    const key = await loadOwnerNotifyApiKey({ env: {}, log });
    expect(key).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      'Owner notify skipped; Resend secret is not configured',
    );
  });

  it('caches a successful Resend secret read for the Lambda container', async () => {
    const getSecret = jest.fn().mockResolvedValueOnce('placeholder');
    const env = {
      [RESEND_SECRET_ARN_ENV]:
        'arn:aws:secretsmanager:eu-west-1:1:secret:wardrobe/dev/resend',
    };
    const first = await loadOwnerNotifyApiKey({ env, getSecret, log });
    const second = await loadOwnerNotifyApiKey({ env, getSecret, log });
    expect(second).toBe(first);
    expect(getSecret).toHaveBeenCalledTimes(1);
    const serialized =
      JSON.stringify(log.warn.mock.calls) + JSON.stringify(log.error.mock.calls);
    expect(serialized).not.toContain('placeholder');
  });
});

