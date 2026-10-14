import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import {
  DEFAULT_BILLING_WEB_ORIGIN,
  checkoutCancelUrl,
  checkoutSuccessUrl,
  portalReturnUrl,
} from '../../src/shared/billing-urls';
import { handler } from '../../src/functions/billing/handler';
import { StoredEntitlement } from '../../src/shared/entitlements';
import { StripeRuntimeConfig } from '../../src/shared/stripe-config';
import { PaidTierSource } from '../../src/shared/types';

const UID = 'firebase-uid-owner';
const CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_test_abc';
const PORTAL_URL = 'https://billing.stripe.com/p/session/test_abc';
const SECRET_KEY = 'sk_test_DO_NOT_LOG_THIS_VALUE_9f3a';
const WEBHOOK_SECRET = 'whsec_DO_NOT_LOG_THIS_EITHER_4c2b';

function asResult(
  result: Awaited<ReturnType<typeof handler>>,
): APIGatewayProxyStructuredResultV2 {
  if (typeof result === 'string') {
    throw new Error('expected a structured API Gateway result');
  }
  return result;
}

function bodyOf(result: APIGatewayProxyStructuredResultV2): unknown {
  return result.body ? JSON.parse(result.body) : undefined;
}

function freeEntitlement(): StoredEntitlement {
  return {
    userId: UID,
    tier: 'FREE',
    status: 'NONE',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function paidEntitlement(
  source: PaidTierSource,
  store: 'APP_STORE' | 'PLAY_STORE' | 'STRIPE',
): StoredEntitlement {
  return {
    userId: UID,
    tier: 'PREMIUM',
    status: 'ACTIVE',
    store,
    source,
    expiresAt: '2026-12-01T00:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function stripeConfig(): StripeRuntimeConfig {
  return {
    mode: 'test',
    secretKey: SECRET_KEY,
    webhookSecret: WEBHOOK_SECRET,
    lookupKeys: {
      basicMonthly: 'wardrobe_basic_monthly',
      premiumMonthly: 'wardrobe_premium_monthly',
      basicYearly: 'wardrobe_basic_yearly',
      premiumYearly: 'wardrobe_premium_yearly',
    },
    priceIds: {},
  };
}

function event(options: {
  body?: unknown;
  sub?: string | null;
  headers?: Record<string, string>;
  method?: string;
  path?: string;
}): APIGatewayProxyEventV2 {
  const method = options.method ?? 'POST';
  const path = options.path ?? '/billing/checkout-session';
  const authorizer =
    options.sub === null
      ? undefined
      : {
          lambda: { sub: options.sub ?? UID },
        };

  return {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: {
      authorization: 'Bearer unused-in-handler',
      origin: 'https://evil.example',
      ...options.headers,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'example.com',
      domainPrefix: 'example',
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'jest',
      },
      requestId: 'req-1',
      routeKey: `${method} ${path}`,
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
      authorizer,
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function mockStripe(options?: {
  priceId?: string;
  url?: string | null;
}) {
  const pricesList = jest.fn().mockResolvedValue({
    data: [{ id: options?.priceId ?? 'price_basic_lookup' }],
  });
  const sessionsCreate = jest.fn().mockResolvedValue({
    url: options?.url === undefined ? CHECKOUT_URL : options.url,
  });
  return {
    prices: { list: pricesList },
    checkout: { sessions: { create: sessionsCreate } },
    pricesList,
    sessionsCreate,
  };
}

function mockPortal(options?: { url?: string | null }) {
  const portalCreate = jest.fn().mockResolvedValue({
    url: options?.url === undefined ? PORTAL_URL : options.url,
  });
  return {
    billingPortal: { sessions: { create: portalCreate } },
    portalCreate,
  };
}

function portalEvent(options: {
  body?: unknown;
  sub?: string | null;
  headers?: Record<string, string>;
  method?: string;
} = {}): APIGatewayProxyEventV2 {
  return event({
    ...options,
    path: '/billing/portal-session',
    body: options.body,
  });
}

describe('POST /billing/checkout-session (WARDROBE-189)', () => {
  it('returns 401 when the authorizer context is missing', async () => {
    const result = asResult(await handler(event({ sub: null, body: { tier: 'basic' } })));
    expect(result.statusCode).toBe(401);
    expect(bodyOf(result)).toEqual({
      error: { code: 'UNAUTHENTICATED', message: expect.any(String) },
    });
  });

  it('returns 400 when tier is missing or invalid', async () => {
    for (const body of [
      {},
      { tier: 'BASIC' },
      { tier: 'FREE' },
      { tier: 'pro' },
      { tier: '' },
      { tier: 1 },
    ]) {
      const result = asResult(await handler(event({ body })));
      expect(result.statusCode).toBe(400);
      expect(bodyOf(result)).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'tier must be "basic" or "premium".',
        },
      });
    }

    const missing = asResult(await handler(event({})));
    expect(missing.statusCode).toBe(400);
    expect((bodyOf(missing) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it.each([
    ['ios', 'APP_STORE'] as const,
    ['android', 'PLAY_STORE'] as const,
    ['stripe', 'STRIPE'] as const,
  ])('returns 409 ALREADY_SUBSCRIBED for an active %s plan', async (source, store) => {
    const stripe = mockStripe();
    const result = asResult(
      await handler(event({ body: { tier: 'basic' } }), {
        resolveEntitlement: async () => paidEntitlement(source, store),
        ensureStripeCustomer: async () => 'cus_should_not_run',
        getStripeConfig: async () => stripeConfig(),
        getStripeClient: async () => stripe,
      }),
    );

    expect(result.statusCode).toBe(409);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'ALREADY_SUBSCRIBED',
        message: 'This account already has a paid plan.',
        source,
      },
    });
    expect(stripe.sessionsCreate).not.toHaveBeenCalled();
  });

  it('defaults interval to monthly when omitted', async () => {
    const stripe = mockStripe({ priceId: 'price_basic_monthly' });
    const result = asResult(
      await handler(event({ body: { tier: 'basic' } }), {
        resolveEntitlement: async () => freeEntitlement(),
        ensureStripeCustomer: async () => 'cus_123',
        getStripeConfig: async () => stripeConfig(),
        getStripeClient: async () => stripe,
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual({ url: CHECKOUT_URL });
    expect(stripe.pricesList).toHaveBeenCalledWith({
      lookup_keys: ['wardrobe_basic_monthly'],
      active: true,
      limit: 1,
    });
  });

  it.each([
    ['basic', 'wardrobe_basic_yearly', 'price_basic_yearly'] as const,
    ['premium', 'wardrobe_premium_yearly', 'price_premium_yearly'] as const,
  ])(
    'uses the yearly lookup key for %s',
    async (tier, lookupKey, priceId) => {
      const stripe = mockStripe({ priceId });
      const result = asResult(
        await handler(event({ body: { tier, interval: 'yearly' } }), {
          resolveEntitlement: async () => freeEntitlement(),
          ensureStripeCustomer: async () => 'cus_123',
          getStripeConfig: async () => stripeConfig(),
          getStripeClient: async () => stripe,
        }),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ url: CHECKOUT_URL });
      expect(Object.keys(bodyOf(result) as object)).toEqual(['url']);
      expect(stripe.pricesList).toHaveBeenCalledWith({
        lookup_keys: [lookupKey],
        active: true,
        limit: 1,
      });
      expect(stripe.sessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: [{ price: priceId, quantity: 1 }],
          subscription_data: { metadata: { uid: UID, tier } },
        }),
      );
    },
  );

  it('returns 400 INVALID_INTERVAL for an invalid interval without Stripe calls', async () => {
    for (const interval of [
      'weekly',
      'Monthly',
      'YEARLY',
      '',
      1,
      true,
      null,
      { period: 'yearly' },
      ['yearly'],
    ]) {
      const stripe = mockStripe();
      const ensureCustomer = jest.fn().mockResolvedValue('cus_should_not_run');
      const getStripeConfig = jest.fn().mockResolvedValue(stripeConfig());
      const getStripeClient = jest.fn().mockResolvedValue(stripe);
      const result = asResult(
        await handler(event({ body: { tier: 'basic', interval } }), {
          resolveEntitlement: async () => freeEntitlement(),
          ensureStripeCustomer: ensureCustomer,
          getStripeConfig,
          getStripeClient,
        }),
      );

      expect(result.statusCode).toBe(400);
      expect(bodyOf(result)).toEqual({
        error: {
          code: 'INVALID_INTERVAL',
          message: 'interval must be "monthly" or "yearly".',
        },
      });
      expect(ensureCustomer).not.toHaveBeenCalled();
      expect(getStripeConfig).not.toHaveBeenCalled();
      expect(getStripeClient).not.toHaveBeenCalled();
      expect(stripe.pricesList).not.toHaveBeenCalled();
      expect(stripe.sessionsCreate).not.toHaveBeenCalled();
    }
  });

  it('returns 503 BILLING_PRICE_NOT_FOUND when a yearly price is missing', async () => {
    const stripe = mockStripe();
    stripe.pricesList.mockResolvedValue({ data: [] });

    const result = asResult(
      await handler(event({ body: { tier: 'premium', interval: 'yearly' } }), {
        resolveEntitlement: async () => freeEntitlement(),
        ensureStripeCustomer: async () => 'cus_123',
        getStripeConfig: async () => stripeConfig(),
        getStripeClient: async () => stripe,
      }),
    );

    expect(result.statusCode).toBe(503);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'BILLING_PRICE_NOT_FOUND',
        message: 'The requested billing plan is not available.',
      },
    });
    expect(JSON.stringify(bodyOf(result))).not.toMatch(/price_/);
    expect(JSON.stringify(bodyOf(result))).not.toContain('sk_test_');
    expect(stripe.sessionsCreate).not.toHaveBeenCalled();
  });

  it('creates a checkout session and returns { url } only', async () => {
    const stripe = mockStripe({ priceId: 'price_from_lookup' });
    const ensureCustomer = jest.fn().mockResolvedValue('cus_123');
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const result = asResult(
      await handler(event({ body: { tier: 'premium' } }), {
        resolveEntitlement: async () => freeEntitlement(),
        ensureStripeCustomer: ensureCustomer,
        getStripeConfig: async () => stripeConfig(),
        getStripeClient: async () => stripe,
        log,
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual({ url: CHECKOUT_URL });
    expect(Object.keys(bodyOf(result) as object)).toEqual(['url']);
    expect(ensureCustomer).toHaveBeenCalledWith(UID);
    expect(stripe.pricesList).toHaveBeenCalledWith({
      lookup_keys: ['wardrobe_premium_monthly'],
      active: true,
      limit: 1,
    });
    expect(stripe.sessionsCreate).toHaveBeenCalledWith({
      mode: 'subscription',
      customer: 'cus_123',
      client_reference_id: UID,
      line_items: [{ price: 'price_from_lookup', quantity: 1 }],
      success_url: checkoutSuccessUrl(DEFAULT_BILLING_WEB_ORIGIN),
      cancel_url: checkoutCancelUrl(DEFAULT_BILLING_WEB_ORIGIN),
      subscription_data: { metadata: { uid: UID, tier: 'premium' } },
    });
  });

  it('resolves a pinned price id from config without listing lookup keys', async () => {
    const stripe = mockStripe();
    const config = stripeConfig();
    config.priceIds.basicMonthly = 'price_pinned_basic';

    await handler(event({ body: { tier: 'basic' } }), {
      resolveEntitlement: async () => freeEntitlement(),
      ensureStripeCustomer: async () => 'cus_123',
      getStripeConfig: async () => config,
      getStripeClient: async () => stripe,
    });

    expect(stripe.pricesList).not.toHaveBeenCalled();
    expect(stripe.sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: 'price_pinned_basic', quantity: 1 }],
      }),
    );
  });

  it('ignores return URL fields from the body and Origin header', async () => {
    const stripe = mockStripe();
    const result = asResult(
      await handler(
        event({
          body: {
            tier: 'basic',
            successUrl: 'https://evil.example/success',
            cancelUrl: 'https://evil.example/cancel',
            success_url: 'https://evil.example/success_url',
            cancel_url: 'https://evil.example/cancel_url',
            url: 'https://evil.example/url',
          },
          headers: {
            origin: 'https://evil.example',
            referer: 'https://evil.example/checkout',
          },
        }),
        {
          resolveEntitlement: async () => freeEntitlement(),
          ensureStripeCustomer: async () => 'cus_123',
          getStripeConfig: async () => stripeConfig(),
          getStripeClient: async () => stripe,
          origin: 'https://preview.example',
        },
      ),
    );

    expect(result.statusCode).toBe(200);
    expect(stripe.sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url:
          'https://preview.example/app/billing/success?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: 'https://preview.example/app/billing/cancel',
      }),
    );
    const created = stripe.sessionsCreate.mock.calls[0]?.[0] as {
      success_url: string;
      cancel_url: string;
    };
    expect(created.success_url).not.toContain('evil.example');
    expect(created.cancel_url).not.toContain('evil.example');
    expect(created.success_url).toContain('{CHECKOUT_SESSION_ID}');
  });

  it('never logs the Stripe secret key or webhook secret', async () => {
    const stripe = mockStripe();
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    await handler(event({ body: { tier: 'basic' } }), {
      resolveEntitlement: async () => freeEntitlement(),
      ensureStripeCustomer: async () => 'cus_123',
      getStripeConfig: async () => stripeConfig(),
      getStripeClient: async () => stripe,
      log,
    });

    const serialized = JSON.stringify({
      info: log.info.mock.calls,
      warn: log.warn.mock.calls,
      error: log.error.mock.calls,
    });
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain(WEBHOOK_SECRET);
    expect(serialized).not.toContain('sk_test_');
    expect(serialized).not.toContain('whsec_');
  });
});

describe('POST /billing/portal-session (WARDROBE-191)', () => {
  it('returns 401 when the authorizer context is missing', async () => {
    const result = asResult(await handler(portalEvent({ sub: null })));
    expect(result.statusCode).toBe(401);
    expect(bodyOf(result)).toEqual({
      error: { code: 'UNAUTHENTICATED', message: expect.any(String) },
    });
  });

  it('creates a portal session and returns { url } only for a Stripe subscriber', async () => {
    const stripe = mockPortal();
    const loadCustomer = jest.fn().mockResolvedValue('cus_123');
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const result = asResult(
      await handler(portalEvent(), {
        resolveEntitlement: async () => paidEntitlement('stripe', 'STRIPE'),
        loadStripeCustomerId: loadCustomer,
        ensureStripeCustomer: async () => 'cus_should_not_run',
        getStripeConfig: async () => stripeConfig(),
        getStripePortalClient: async () => stripe,
        log,
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual({ url: PORTAL_URL });
    expect(Object.keys(bodyOf(result) as object)).toEqual(['url']);
    expect(loadCustomer).toHaveBeenCalledWith(UID);
    expect(stripe.portalCreate).toHaveBeenCalledWith({
      customer: 'cus_123',
      return_url: portalReturnUrl(DEFAULT_BILLING_WEB_ORIGIN),
    });
    expect(log.info).toHaveBeenCalledWith(
      'Stripe billing portal session created',
      expect.objectContaining({ mode: 'test', hasConfiguration: false }),
    );
  });

  it.each([
    ['ios', 'APP_STORE', 'ios'] as const,
    ['android', 'PLAY_STORE', 'android'] as const,
  ])(
    'returns 409 NOT_STRIPE_PLAN for an active %s plan',
    async (source, store, expectedSource) => {
      const stripe = mockPortal();
      const result = asResult(
        await handler(portalEvent(), {
          resolveEntitlement: async () => paidEntitlement(source, store),
          loadStripeCustomerId: async () => 'cus_should_not_run',
          getStripeConfig: async () => stripeConfig(),
          getStripePortalClient: async () => stripe,
        }),
      );

      expect(result.statusCode).toBe(409);
      expect(bodyOf(result)).toEqual({
        error: {
          code: 'NOT_STRIPE_PLAN',
          message: 'Manage plan is only available for Stripe subscriptions.',
          source: expectedSource,
        },
      });
      expect(stripe.portalCreate).not.toHaveBeenCalled();
    },
  );

  it('returns 409 NOT_STRIPE_PLAN with source null for a free account', async () => {
    const stripe = mockPortal();
    const result = asResult(
      await handler(portalEvent(), {
        resolveEntitlement: async () => freeEntitlement(),
        loadStripeCustomerId: async () => 'cus_should_not_run',
        getStripeConfig: async () => stripeConfig(),
        getStripePortalClient: async () => stripe,
      }),
    );

    expect(result.statusCode).toBe(409);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'NOT_STRIPE_PLAN',
        message: 'Manage plan is only available for Stripe subscriptions.',
        source: null,
      },
    });
    expect(stripe.portalCreate).not.toHaveBeenCalled();
  });

  it('returns 409 NOT_STRIPE_PLAN when a Stripe plan has no stored customer id', async () => {
    const stripe = mockPortal();
    const result = asResult(
      await handler(portalEvent(), {
        resolveEntitlement: async () => paidEntitlement('stripe', 'STRIPE'),
        loadStripeCustomerId: async () => undefined,
        ensureStripeCustomer: async () => 'cus_should_not_create',
        getStripeConfig: async () => stripeConfig(),
        getStripePortalClient: async () => stripe,
      }),
    );

    expect(result.statusCode).toBe(409);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'NOT_STRIPE_PLAN',
        message: 'Manage plan is only available for Stripe subscriptions.',
        source: 'stripe',
      },
    });
    expect(stripe.portalCreate).not.toHaveBeenCalled();
  });

  it('builds return_url server-side and ignores body and header URLs', async () => {
    const stripe = mockPortal();
    const result = asResult(
      await handler(
        portalEvent({
          body: {
            return_url: 'https://evil.example/return_url',
            returnUrl: 'https://evil.example/returnUrl',
            url: 'https://evil.example/url',
            successUrl: 'https://evil.example/success',
            cancelUrl: 'https://evil.example/cancel',
          },
          headers: {
            origin: 'https://evil.example',
            referer: 'https://evil.example/settings',
          },
        }),
        {
          resolveEntitlement: async () => paidEntitlement('stripe', 'STRIPE'),
          loadStripeCustomerId: async () => 'cus_123',
          getStripeConfig: async () => stripeConfig(),
          getStripePortalClient: async () => stripe,
          origin: 'https://preview.example',
        },
      ),
    );

    expect(result.statusCode).toBe(200);
    expect(stripe.portalCreate).toHaveBeenCalledWith({
      customer: 'cus_123',
      return_url: 'https://preview.example/app/settings#plan',
    });
    const created = stripe.portalCreate.mock.calls[0]?.[0] as {
      return_url: string;
    };
    expect(created.return_url).not.toContain('evil.example');
    expect(created.return_url).toBe(portalReturnUrl('https://preview.example'));
  });

  it('accepts an empty body', async () => {
    const stripe = mockPortal();
    const result = asResult(
      await handler(portalEvent(), {
        resolveEntitlement: async () => paidEntitlement('stripe', 'STRIPE'),
        loadStripeCustomerId: async () => 'cus_123',
        getStripeConfig: async () => stripeConfig(),
        getStripePortalClient: async () => stripe,
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual({ url: PORTAL_URL });
  });

  it('passes a configured portal configuration id through to Stripe', async () => {
    const stripe = mockPortal();
    await handler(portalEvent(), {
      resolveEntitlement: async () => paidEntitlement('stripe', 'STRIPE'),
      loadStripeCustomerId: async () => 'cus_123',
      getStripeConfig: async () => stripeConfig(),
      getStripePortalClient: async () => stripe,
      portalConfigurationId: 'bpc_configured',
    });

    expect(stripe.portalCreate).toHaveBeenCalledWith({
      customer: 'cus_123',
      return_url: portalReturnUrl(DEFAULT_BILLING_WEB_ORIGIN),
      configuration: 'bpc_configured',
    });
  });

  it('never logs the Stripe secret key or webhook secret', async () => {
    const stripe = mockPortal();
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    await handler(portalEvent(), {
      resolveEntitlement: async () => paidEntitlement('stripe', 'STRIPE'),
      loadStripeCustomerId: async () => 'cus_123',
      getStripeConfig: async () => stripeConfig(),
      getStripePortalClient: async () => stripe,
      log,
    });

    const serialized = JSON.stringify({
      info: log.info.mock.calls,
      warn: log.warn.mock.calls,
      error: log.error.mock.calls,
    });
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain(WEBHOOK_SECRET);
    expect(serialized).not.toContain('sk_test_');
    expect(serialized).not.toContain('whsec_');
  });
});
