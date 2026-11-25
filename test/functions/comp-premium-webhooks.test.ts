const mockQueryByPk = jest.fn();
const mockPutItem = jest.fn();
const mockPutItemIfNotExists = jest.fn();
const mockGetItem = jest.fn();
const mockDeleteItem = jest.fn();

jest.mock('../../src/shared/dynamodb', () => {
  const actual = jest.requireActual('../../src/shared/dynamodb') as typeof import('../../src/shared/dynamodb');
  return {
    ...actual,
    queryByPk: (...args: unknown[]) => mockQueryByPk(...args),
    putItem: (...args: unknown[]) => mockPutItem(...args),
    putItemIfNotExists: (...args: unknown[]) => mockPutItemIfNotExists(...args),
    getItem: (...args: unknown[]) => mockGetItem(...args),
    deleteItem: (...args: unknown[]) => mockDeleteItem(...args),
  };
});

import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import Stripe from 'stripe';
import { handleSuperwallWebhook } from '../../src/functions/entitlements-webhook/handler';
import { handleStripeWebhook } from '../../src/functions/stripe-webhook/handler';
import { keys } from '../../src/shared/dynamodb';
import { deriveSuperwallAppUserId, resolveEntitlement } from '../../src/shared/entitlements';
import { StripeRuntimeConfig } from '../../src/shared/stripe-config';
import { signSvixWebhook } from '../../src/shared/svix';

const SUPERWALL_SECRET = `whsec_${Buffer.from('unit-test-superwall-secret').toString('base64')}`;
const TIMESTAMP = '1710000000';
const SVIX_ID = 'msg_comp_1';
const UID = 'firebase-uid-owner';
const STRIPE_WEBHOOK_SECRET = 'whsec_comp_premium_test_secret';
const STRIPE_SECRET_KEY = 'sk_test_comp_premium_not_logged';
const SUB_ID = 'sub_comp_test';
const CUS_ID = 'cus_comp_test';
const EVENT_ID = 'evt_comp_stripe_1';
const NOW_MS = Date.parse('2026-11-25T12:00:00.000Z');

function asResult(
  result: Awaited<ReturnType<typeof handleSuperwallWebhook>>,
): APIGatewayProxyStructuredResultV2 {
  if (typeof result === 'string') {
    throw new Error('expected a structured API Gateway result');
  }
  return result;
}

function bodyOf(result: APIGatewayProxyStructuredResultV2): unknown {
  return result.body ? JSON.parse(result.body) : undefined;
}

function compRow() {
  return {
    PK: `USER#${UID}`,
    SK: keys.entitlementCompSk,
    entityType: 'ENTITLEMENT',
    userId: UID,
    tier: 'PREMIUM',
    status: 'ACTIVE',
    store: 'COMP',
    source: 'comp',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

function storeRow(overrides: Record<string, unknown> = {}) {
  return {
    PK: `USER#${UID}`,
    SK: 'ENTITLEMENT#2026-10-01T00:00:00.000Z#evt_store',
    entityType: 'ENTITLEMENT',
    userId: UID,
    tier: 'PREMIUM',
    status: 'ACTIVE',
    store: 'APP_STORE',
    source: 'ios',
    productId: 'premium_monthly',
    expiresAt: '2026-10-16T00:00:00.000Z',
    lastEventId: 'evt_store',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function assertCompUntouched(): void {
  for (const call of mockPutItem.mock.calls) {
    expect(call[0].SK).not.toBe(keys.entitlementCompSk);
    expect(call[0].source).not.toBe('comp');
    expect(call[0].store).not.toBe('COMP');
  }
  for (const call of mockDeleteItem.mock.calls) {
    expect(call).not.toEqual([`USER#${UID}`, keys.entitlementCompSk]);
    if (typeof call[1] === 'string') {
      expect(call[1]).not.toBe(keys.entitlementCompSk);
    }
  }
  for (const call of mockPutItemIfNotExists.mock.calls) {
    expect(call[0]?.SK).not.toBe(keys.entitlementCompSk);
  }
}

function superwallEvent(payload: string): APIGatewayProxyEventV2 {
  const signature = signSvixWebhook({
    payload,
    id: SVIX_ID,
    timestamp: TIMESTAMP,
    webhookSecret: SUPERWALL_SECRET,
  });
  return {
    version: '2.0',
    routeKey: 'POST /webhooks/superwall',
    rawPath: '/webhooks/superwall',
    rawQueryString: '',
    headers: {
      'svix-id': SVIX_ID,
      'svix-timestamp': TIMESTAMP,
      'svix-signature': signature,
    },
    body: payload,
    isBase64Encoded: false,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'example.com',
      domainPrefix: 'example',
      http: {
        method: 'POST',
        path: '/webhooks/superwall',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'svix',
      },
      requestId: 'req-comp-webhook',
      routeKey: 'POST /webhooks/superwall',
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
    },
  } as unknown as APIGatewayProxyEventV2;
}

function expirationPayload(store: 'APP_STORE' | 'PLAY_STORE') {
  return JSON.stringify({
    object: 'event',
    type: 'expiration',
    data: {
      id: `evt_exp_${store}`,
      name: 'expiration',
      productId: 'premium_monthly',
      originalAppUserId: deriveSuperwallAppUserId(UID),
      userAttributes: { firebaseUid: UID },
      store,
    },
  });
}

function stripeConfig(): StripeRuntimeConfig {
  return {
    mode: 'test',
    secretKey: STRIPE_SECRET_KEY,
    webhookSecret: STRIPE_WEBHOOK_SECRET,
    lookupKeys: {
      basicMonthly: 'wardrobe_basic_monthly',
      premiumMonthly: 'wardrobe_premium_monthly',
      basicYearly: 'wardrobe_basic_yearly',
      premiumYearly: 'wardrobe_premium_yearly',
    },
    priceIds: {},
  };
}

function stripeWebhookEvent(payload: string, signature: string): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /billing/stripe-webhook',
    rawPath: '/billing/stripe-webhook',
    rawQueryString: '',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
    },
    body: payload,
    isBase64Encoded: false,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'example.com',
      domainPrefix: 'example',
      http: {
        method: 'POST',
        path: '/billing/stripe-webhook',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'Stripe/1.0',
      },
      requestId: 'req-comp-stripe',
      routeKey: 'POST /billing/stripe-webhook',
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
    },
  } as unknown as APIGatewayProxyEventV2;
}

describe('COMP row survives store webhooks and lapse (WARDROBE-291)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryByPk.mockResolvedValue([compRow(), storeRow()]);
    mockPutItem.mockResolvedValue(undefined);
    mockPutItemIfNotExists.mockResolvedValue(true);
    mockGetItem.mockResolvedValue(undefined);
    mockDeleteItem.mockResolvedValue(undefined);
  });

  function superwallDeps() {
    return {
      loadConfig: async () => ({
        webhookSecret: SUPERWALL_SECRET,
        productTiers: {},
      }),
      loadTrackingConsent: async () => false,
      nowSeconds: Number(TIMESTAMP),
    };
  }

  it.each([
    ['App Store', 'APP_STORE' as const],
    ['Play', 'PLAY_STORE' as const],
  ])(
    'Superwall %s expiration does not write or delete COMP; user stays PREMIUM',
    async (_label, store) => {
      mockQueryByPk.mockResolvedValue([
        compRow(),
        storeRow({
          store,
          source: store === 'APP_STORE' ? 'ios' : 'android',
        }),
      ]);

      const result = asResult(
        await handleSuperwallWebhook(
          superwallEvent(expirationPayload(store)),
          superwallDeps(),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual(
        expect.objectContaining({
          status: 'applied',
          eventName: 'expiration',
        }),
      );
      expect(mockPutItem).toHaveBeenCalled();
      assertCompUntouched();

      const resolved = await resolveEntitlement(UID, NOW_MS);
      expect(resolved.tier).toBe('PREMIUM');
      expect(resolved.source).toBe('comp');
      expect(resolved.sk).toBe(keys.entitlementCompSk);
    },
  );

  it('Stripe cancel webhook does not write or delete COMP; user stays PREMIUM', async () => {
    mockQueryByPk.mockResolvedValue([
      compRow(),
      storeRow({
        store: 'STRIPE',
        source: 'stripe',
        status: 'ACTIVE',
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
    ]);
    mockPutItemIfNotExists.mockResolvedValue(true);

    const payload = JSON.stringify({
      id: EVENT_ID,
      object: 'event',
      type: 'customer.subscription.deleted',
      created: 1_717_000_000,
      data: {
        object: {
          id: SUB_ID,
          object: 'subscription',
          status: 'canceled',
          customer: CUS_ID,
          metadata: { uid: UID },
        },
      },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: STRIPE_WEBHOOK_SECRET,
    });

    const result = asResult(
      await handleStripeWebhook(stripeWebhookEvent(payload, signature), {
        loadConfig: async () => stripeConfig(),
        getStripeClient: async () => ({
          subscriptions: {
            retrieve: async () => ({
              id: SUB_ID,
              status: 'canceled',
              customer: { id: CUS_ID, metadata: { uid: UID } },
              metadata: { uid: UID, tier: 'premium' },
              items: {
                data: [
                  {
                    price: {
                      id: 'price_premium',
                      lookup_key: 'wardrobe_premium_monthly',
                    },
                  },
                ],
              },
            }),
          },
          customers: {
            retrieve: async () => ({ id: CUS_ID, metadata: { uid: UID } }),
          },
        }),
        recordEventIfNew: async () => true,
        forgetEvent: async () => undefined,
        persistStripeCustomerMapping: async () => true,
        log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual(
      expect.objectContaining({ status: 'cleared' }),
    );
    expect(mockPutItem).toHaveBeenCalled();
    assertCompUntouched();

    const resolved = await resolveEntitlement(UID, NOW_MS);
    expect(resolved.tier).toBe('PREMIUM');
    expect(resolved.source).toBe('comp');
  });

  it('read-time lapse (no expiry job) does not drop COMP Premium', async () => {
    mockQueryByPk.mockResolvedValue([
      compRow(),
      storeRow({
        status: 'ACTIVE',
        expiresAt: '2020-01-01T00:00:00.000Z',
      }),
    ]);
    const resolved = await resolveEntitlement(UID, NOW_MS);
    expect(resolved.tier).toBe('PREMIUM');
    expect(resolved.source).toBe('comp');
    expect(mockPutItem).not.toHaveBeenCalled();
    expect(mockDeleteItem).not.toHaveBeenCalled();
  });
});
