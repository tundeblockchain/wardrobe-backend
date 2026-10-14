import { AppError } from '../../src/shared/errors';
import { logger } from '../../src/shared/logger';
import {
  CANCELABLE_STRIPE_SUBSCRIPTION_STATUSES,
  cancelAccountStripeSubscriptions,
  isIgnorableStripeCancelError,
  StripeCancelClient,
  stripeSubscriptionCancelIdempotencyKey,
} from '../../src/shared/stripe-cancel';

const UID = 'firebase-uid-owner';
const CUSTOMER = 'cus_test_123';
const SECRET = 'sk_test_DO_NOT_LOG_THIS_VALUE_9f3a';

function stripeError(
  message: string,
  extras: { code?: string; statusCode?: number; status?: string | number } = {},
): Error {
  return Object.assign(new Error(message), extras);
}

function mockStripe(options: {
  list?: StripeCancelClient['subscriptions']['list'];
  cancel?: StripeCancelClient['subscriptions']['cancel'];
}): {
  client: StripeCancelClient;
  list: jest.Mock;
  cancel: jest.Mock;
} {
  const list =
    options.list ??
    jest.fn(async () => ({ data: [] as Array<{ id: string; status: string }> }));
  const cancel =
    options.cancel ?? jest.fn(async (id: string) => ({ id, status: 'canceled' }));
  return {
    client: { subscriptions: { list, cancel } },
    list: list as jest.Mock,
    cancel: cancel as jest.Mock,
  };
}

describe('stripe account-delete cancel (WARDROBE-192)', () => {
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    warn.mockRestore();
    error.mockRestore();
    info.mockRestore();
  });

  it('names an idempotency key per subscription', () => {
    expect(stripeSubscriptionCancelIdempotencyKey('sub_abc')).toBe(
      'account-delete-cancel-sub_abc',
    );
  });

  it('treats resource_missing, 404, and status canceled as ignorable', () => {
    expect(
      isIgnorableStripeCancelError(stripeError('No such subscription', { code: 'resource_missing' })),
    ).toBe(true);
    expect(
      isIgnorableStripeCancelError(stripeError('not found', { statusCode: 404 })),
    ).toBe(true);
    expect(
      isIgnorableStripeCancelError(stripeError('not found', { status: 404 })),
    ).toBe(true);
    expect(
      isIgnorableStripeCancelError(stripeError('already canceled', { status: 'canceled' })),
    ).toBe(true);
    expect(isIgnorableStripeCancelError(stripeError('card declined'))).toBe(false);
    expect(
      isIgnorableStripeCancelError(stripeError('rate limited', { statusCode: 429 })),
    ).toBe(false);
  });

  it('skips Stripe when the account has no stripeCustomerId', async () => {
    const { client, list, cancel } = mockStripe({});
    await expect(
      cancelAccountStripeSubscriptions(
        { userId: UID },
        {
          loadStripeCustomerId: async () => undefined,
          getStripeClient: async () => client,
        },
      ),
    ).resolves.toEqual({ status: 'SKIPPED', reason: 'no_customer' });
    expect(list).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('skips Stripe and warns when the dedicated secret is empty', async () => {
    const { client, cancel } = mockStripe({});
    await expect(
      cancelAccountStripeSubscriptions(
        { userId: UID, stripeCustomerId: CUSTOMER },
        {
          getStripeConfig: async () => {
            throw new Error('STRIPE_SECRET_ARN is not set.');
          },
          getStripeClient: async () => client,
          loadSuperwallStripeSecret: async () => undefined,
        },
      ),
    ).resolves.toEqual({ status: 'SKIPPED', reason: 'stripe_unconfigured' });
    expect(cancel).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'Stripe cancel skipped; Stripe is not configured',
      expect.objectContaining({ reason: 'stripe_unconfigured' }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  });

  it('cancels active, trialing, and past_due subscriptions immediately', async () => {
    const { client, list, cancel } = mockStripe({
      list: jest.fn(async ({ status }) => {
        if (status === 'active') {
          return { data: [{ id: 'sub_active', status: 'active' }] };
        }
        if (status === 'trialing') {
          return { data: [{ id: 'sub_trial', status: 'trialing' }] };
        }
        if (status === 'past_due') {
          return { data: [{ id: 'sub_due', status: 'past_due' }] };
        }
        return { data: [] };
      }),
    });

    await expect(
      cancelAccountStripeSubscriptions(
        { userId: UID, stripeCustomerId: CUSTOMER },
        { getStripeClient: async () => client },
      ),
    ).resolves.toEqual({
      status: 'CANCELED',
      canceledIds: ['sub_active', 'sub_trial', 'sub_due'],
    });

    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls.map((call) => call[0].status).sort()).toEqual(
      [...CANCELABLE_STRIPE_SUBSCRIPTION_STATUSES].sort(),
    );
    expect(cancel).toHaveBeenCalledTimes(3);
    for (const [id, params, options] of cancel.mock.calls) {
      expect(params).toEqual({});
      expect(params).not.toHaveProperty('cancel_at_period_end');
      expect(options).toEqual({
        idempotencyKey: stripeSubscriptionCancelIdempotencyKey(id),
      });
    }
  });

  it('proceeds when there is a customer but no cancelable subscriptions', async () => {
    const { client, cancel } = mockStripe({});
    await expect(
      cancelAccountStripeSubscriptions(
        { userId: UID, stripeCustomerId: CUSTOMER },
        { getStripeClient: async () => client },
      ),
    ).resolves.toEqual({ status: 'SKIPPED', reason: 'no_subscriptions' });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('does not block delete when cancel returns resource_missing', async () => {
    const { client } = mockStripe({
      list: jest.fn(async ({ status }) =>
        status === 'active'
          ? { data: [{ id: 'sub_gone', status: 'active' }] }
          : { data: [] },
      ),
      cancel: jest.fn(async () => {
        throw stripeError('No such subscription: sub_gone', {
          code: 'resource_missing',
          statusCode: 404,
        });
      }),
    });

    await expect(
      cancelAccountStripeSubscriptions(
        { userId: UID, stripeCustomerId: CUSTOMER },
        { getStripeClient: async () => client },
      ),
    ).resolves.toEqual({ status: 'CANCELED', canceledIds: [] });
  });

  it('does not block delete when a listed subscription is already canceled', async () => {
    const { client, cancel } = mockStripe({
      list: jest.fn(async ({ status }) =>
        status === 'active'
          ? { data: [{ id: 'sub_old', status: 'canceled' }] }
          : { data: [] },
      ),
    });

    await expect(
      cancelAccountStripeSubscriptions(
        { userId: UID, stripeCustomerId: CUSTOMER },
        { getStripeClient: async () => client },
      ),
    ).resolves.toEqual({ status: 'SKIPPED', reason: 'no_subscriptions' });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('does not block delete when cancel reports status canceled', async () => {
    const { client } = mockStripe({
      list: jest.fn(async ({ status }) =>
        status === 'active'
          ? { data: [{ id: 'sub_done', status: 'active' }] }
          : { data: [] },
      ),
      cancel: jest.fn(async () => {
        throw stripeError('Subscription is canceled', { status: 'canceled' });
      }),
    });

    await expect(
      cancelAccountStripeSubscriptions(
        { userId: UID, stripeCustomerId: CUSTOMER },
        { getStripeClient: async () => client },
      ),
    ).resolves.toEqual({ status: 'CANCELED', canceledIds: [] });
  });

  it('throws BILLING_CANCEL_FAILED when a Stripe cancel call fails', async () => {
    const { client } = mockStripe({
      list: jest.fn(async ({ status }) =>
        status === 'active'
          ? { data: [{ id: 'sub_live', status: 'active' }] }
          : { data: [] },
      ),
      cancel: jest.fn(async () => {
        throw stripeError(`Stripe API down using ${SECRET}`, { statusCode: 500 });
      }),
    });

    await expect(
      cancelAccountStripeSubscriptions(
        { userId: UID, stripeCustomerId: CUSTOMER },
        { getStripeClient: async () => client },
      ),
    ).rejects.toMatchObject({
      code: 'BILLING_CANCEL_FAILED',
      statusCode: 503,
      retryable: true,
    });
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain(SECRET);
  });

  it('throws BILLING_CANCEL_FAILED when listing subscriptions fails', async () => {
    const { client, cancel } = mockStripe({
      list: jest.fn(async () => {
        throw stripeError('Stripe list unavailable');
      }),
    });

    await expect(
      cancelAccountStripeSubscriptions(
        { userId: UID, stripeCustomerId: CUSTOMER },
        { getStripeClient: async () => client },
      ),
    ).rejects.toBeInstanceOf(AppError);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('uses the Superwall stripeSecretKey only as a fallback', async () => {
    const { client, cancel } = mockStripe({
      list: jest.fn(async ({ status }) =>
        status === 'active'
          ? { data: [{ id: 'sub_fallback', status: 'active' }] }
          : { data: [] },
      ),
    });
    const createClient = jest.fn(() => client);

    await cancelAccountStripeSubscriptions(
      { userId: UID, stripeCustomerId: CUSTOMER },
      {
        getStripeConfig: async () => {
          throw new Error('STRIPE_SECRET_ARN is not set.');
        },
        loadSuperwallStripeSecret: async () => SECRET,
        createClient,
      },
    );

    expect(createClient).toHaveBeenCalledWith(SECRET);
    expect(cancel).toHaveBeenCalledWith(
      'sub_fallback',
      {},
      { idempotencyKey: 'account-delete-cancel-sub_fallback' },
    );
    expect(info).toHaveBeenCalledWith(
      'Stripe cancel using Superwall stripeSecretKey fallback',
      expect.objectContaining({ reason: 'superwall_fallback' }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain(SECRET);
  });
});
