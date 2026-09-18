import { StoredEntitlement } from '../../src/shared/entitlements';
import { logger } from '../../src/shared/logger';
import {
  cancelConfigFromSecret,
  cancelUserSubscription,
  FetchLike,
  SubscriptionCancelConfig,
} from '../../src/functions/me/cancel';
import { parseSuperwallSecret } from '../../src/shared/superwall-config';

const OWNER_ID = 'firebase-uid-owner';
const EXPIRES = '2026-10-01T00:00:00.000Z';

function entitlement(
  overrides: Partial<StoredEntitlement> = {},
): StoredEntitlement {
  return {
    userId: OWNER_ID,
    tier: 'PREMIUM',
    status: 'ACTIVE',
    productId: 'premium_monthly',
    store: 'APP_STORE',
    expiresAt: EXPIRES,
    originalTransactionId: '700002050981465',
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(
  status: number,
  body: unknown,
  contentType = 'application/json',
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { 'content-type': contentType },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

describe('subscription cancel client (WARDROBE-103)', () => {
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    warn.mockRestore();
  });

  it('returns NONE when there is no entitlement row', async () => {
    const fetchImpl = jest.fn();
    await expect(
      cancelUserSubscription(
        { userId: OWNER_ID },
        { loadConfig: async () => ({}), fetchImpl },
      ),
    ).resolves.toEqual({ status: 'NONE' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns NONE for an expired row without calling a store', async () => {
    const fetchImpl = jest.fn();
    await expect(
      cancelUserSubscription(
        {
          userId: OWNER_ID,
          entitlement: entitlement({ status: 'EXPIRED', store: 'PLAY_STORE' }),
        },
        { loadConfig: async () => ({}), fetchImpl },
      ),
    ).resolves.toEqual({
      status: 'NONE',
      store: 'PLAY_STORE',
      expiresAt: EXPIRES,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats an already-canceled row as CANCELED at period end when expiresAt is in the future', async () => {
    const fetchImpl = jest.fn();
    await expect(
      cancelUserSubscription(
        {
          userId: OWNER_ID,
          entitlement: entitlement({ status: 'CANCELED' }),
        },
        {
          loadConfig: async () => ({}),
          fetchImpl,
          nowMs: () => Date.parse('2026-09-18T00:00:00.000Z'),
        },
      ),
    ).resolves.toEqual({
      status: 'CANCELED',
      cancelMode: 'PERIOD_END',
      store: 'APP_STORE',
      expiresAt: EXPIRES,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not call Apple; App Store cancel is client-driven', async () => {
    const fetchImpl = jest.fn();
    await expect(
      cancelUserSubscription(
        { userId: OWNER_ID, entitlement: entitlement() },
        { loadConfig: async () => ({}), fetchImpl },
      ),
    ).resolves.toEqual({
      status: 'CANCEL_FAILED',
      retryInStore: true,
      store: 'APP_STORE',
      expiresAt: EXPIRES,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/App Store has no server cancel API/),
      expect.objectContaining({ store: 'APP_STORE' }),
    );
  });

  it('cancels Stripe immediately when a secret and subscription id are present', async () => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(
      async (url, init) => {
        expect(url).toBe('https://api.stripe.com/v1/subscriptions/sub_test123');
        expect(init?.method).toBe('DELETE');
        expect(init?.headers?.Authorization).toBe('Bearer sk_test_placeholder');
        return jsonResponse(200, { id: 'sub_test123', status: 'canceled' });
      },
    );

    await expect(
      cancelUserSubscription(
        {
          userId: OWNER_ID,
          entitlement: entitlement({
            store: 'STRIPE',
            originalTransactionId: 'sub_test123',
          }),
        },
        {
          loadConfig: async () => ({ stripeSecretKey: 'sk_test_placeholder' }),
          fetchImpl,
        },
      ),
    ).resolves.toEqual({
      status: 'CANCELED',
      cancelMode: 'IMMEDIATE',
      store: 'STRIPE',
      expiresAt: EXPIRES,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns CANCEL_FAILED and logs status/content-type/snippet when Stripe errors', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse(401, { error: { message: 'invalid Bearer sk_live_secret' } }),
    );

    await expect(
      cancelUserSubscription(
        {
          userId: OWNER_ID,
          entitlement: entitlement({
            store: 'STRIPE',
            originalTransactionId: 'sub_test123',
          }),
        },
        {
          loadConfig: async () => ({ stripeSecretKey: 'sk_test_placeholder' }),
          fetchImpl,
        },
      ),
    ).resolves.toEqual({
      status: 'CANCEL_FAILED',
      retryInStore: true,
      store: 'STRIPE',
      expiresAt: EXPIRES,
    });

    const fields = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(fields).toEqual(
      expect.objectContaining({
        store: 'STRIPE',
        status: 401,
        contentType: 'application/json',
      }),
    );
    expect(JSON.stringify(fields)).not.toMatch(/sk_live_secret|sk_test_placeholder/);
  });

  it('revokes Play immediately when credentials and a token are present', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      expect(url).toContain('/purchases/subscriptionsv2/tokens/play-token-1:revoke');
      return jsonResponse(200, {});
    });

    await expect(
      cancelUserSubscription(
        {
          userId: OWNER_ID,
          entitlement: entitlement({
            store: 'PLAY_STORE',
            originalTransactionId: 'play-token-1',
          }),
        },
        {
          loadConfig: async (): Promise<SubscriptionCancelConfig> => ({
            playPackageName: 'app.wardrobe.android',
            playAccessToken: 'ya29.test-token',
          }),
          fetchImpl,
        },
      ),
    ).resolves.toEqual({
      status: 'CANCELED',
      cancelMode: 'IMMEDIATE',
      store: 'PLAY_STORE',
      expiresAt: EXPIRES,
    });
  });

  it('falls back to Play cancel-at-period-end when revoke is rejected', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.endsWith(':revoke')) {
        return jsonResponse(400, { error: 'not eligible' });
      }
      expect(url).toContain(':cancel');
      return jsonResponse(200, {});
    });

    await expect(
      cancelUserSubscription(
        {
          userId: OWNER_ID,
          entitlement: entitlement({
            store: 'PLAY_STORE',
            originalTransactionId: 'play-token-1',
          }),
        },
        {
          loadConfig: async () => ({
            playPackageName: 'app.wardrobe.android',
            playAccessToken: 'ya29.test-token',
          }),
          fetchImpl,
        },
      ),
    ).resolves.toEqual({
      status: 'CANCEL_AT_PERIOD_END',
      cancelMode: 'PERIOD_END',
      store: 'PLAY_STORE',
      expiresAt: EXPIRES,
    });
  });

  it('returns CANCEL_FAILED when Play credentials are missing', async () => {
    const fetchImpl = jest.fn();
    await expect(
      cancelUserSubscription(
        {
          userId: OWNER_ID,
          entitlement: entitlement({ store: 'PLAY_STORE' }),
        },
        { loadConfig: async () => ({}), fetchImpl },
      ),
    ).resolves.toEqual({
      status: 'CANCEL_FAILED',
      retryInStore: true,
      store: 'PLAY_STORE',
      expiresAt: EXPIRES,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores placeholder Stripe keys from the Superwall secret', () => {
    expect(
      cancelConfigFromSecret(
        parseSuperwallSecret(
          JSON.stringify({
            webhookSecret: 'whsec_test',
            stripeSecretKey: 'sk_your_stripe_secret',
            playPackageName: 'your.android.package',
          }),
        ),
      ),
    ).toEqual({});
  });
});
