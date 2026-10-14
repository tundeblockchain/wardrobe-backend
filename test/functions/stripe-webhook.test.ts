import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import Stripe from 'stripe';
import { handleStripeWebhook } from '../../src/functions/stripe-webhook/handler';
import { StripeRuntimeConfig } from '../../src/shared/stripe-config';
import {
  STRIPE_WEBHOOK_EVENT_TYPES,
  StripeSubscriptionLike,
} from '../../src/shared/stripe-webhook';
import { StoredEntitlement } from '../../src/shared/entitlements';

const mockPutItem = jest.fn();
const mockPutItemIfNotExists = jest.fn();
const mockGetItem = jest.fn();
const mockQueryByPk = jest.fn();
const mockDeleteItem = jest.fn();

jest.mock('../../src/shared/dynamodb', () => {
  const actual = jest.requireActual('../../src/shared/dynamodb') as typeof import('../../src/shared/dynamodb');
  return {
    ...actual,
    putItem: (...args: unknown[]) => mockPutItem(...args),
    putItemIfNotExists: (...args: unknown[]) => mockPutItemIfNotExists(...args),
    getItem: (...args: unknown[]) => mockGetItem(...args),
    queryByPk: (...args: unknown[]) => mockQueryByPk(...args),
    deleteItem: (...args: unknown[]) => mockDeleteItem(...args),
  };
});

const WEBHOOK_SECRET = 'whsec_DO_NOT_LOG_THIS_EITHER_4c2b';
const SECRET_KEY = 'sk_test_DO_NOT_LOG_THIS_VALUE_9f3a';
const UID = 'firebase-uid-owner';
const SUB_ID = 'sub_test_123';
const CUS_ID = 'cus_test_123';
const EVENT_ID = 'evt_test_123';
const PERIOD_END = 1762819200; // 2025-11-11T00:00:00.000Z

function asResult(
  result: Awaited<ReturnType<typeof handleStripeWebhook>>,
): APIGatewayProxyStructuredResultV2 {
  if (typeof result === 'string') {
    throw new Error('expected a structured API Gateway result');
  }
  return result;
}

function bodyOf(result: APIGatewayProxyStructuredResultV2): unknown {
  return result.body ? JSON.parse(result.body) : undefined;
}

function stripeConfig(): StripeRuntimeConfig {
  return {
    mode: 'test',
    secretKey: SECRET_KEY,
    webhookSecret: WEBHOOK_SECRET,
    lookupKeys: {
      basicMonthly: 'wardrobe_basic_monthly',
      premiumMonthly: 'wardrobe_premium_monthly',
    },
    priceIds: {},
  };
}

function subscription(overrides: Partial<StripeSubscriptionLike> = {}): StripeSubscriptionLike {
  return {
    id: SUB_ID,
    status: 'active',
    customer: { id: CUS_ID, metadata: { uid: UID } },
    metadata: { uid: UID, tier: 'premium' },
    current_period_end: PERIOD_END,
    items: {
      data: [
        {
          current_period_end: PERIOD_END,
          price: {
            id: 'price_premium',
            lookup_key: 'wardrobe_premium_monthly',
          },
        },
      ],
    },
    ...overrides,
  };
}

function stripeEventObject(options: {
  type: string;
  id?: string;
  object?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: options.id ?? EVENT_ID,
    object: 'event',
    type: options.type,
    created: 1_717_000_000,
    data: {
      object: options.object ?? {
        id: SUB_ID,
        object: 'subscription',
        status: 'active',
        customer: CUS_ID,
        metadata: { uid: UID },
      },
    },
  };
}

function signedPayload(eventObject: Record<string, unknown>): {
  payload: string;
  signature: string;
} {
  const payload = JSON.stringify(eventObject);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  });
  return { payload, signature };
}

function webhookEvent(options: {
  payload: string;
  signature?: string;
  base64?: boolean;
  omitSignature?: boolean;
  method?: string;
}): APIGatewayProxyEventV2 {
  const body = options.base64
    ? Buffer.from(options.payload, 'utf8').toString('base64')
    : options.payload;
  return {
    version: '2.0',
    routeKey: 'POST /billing/stripe-webhook',
    rawPath: '/billing/stripe-webhook',
    rawQueryString: '',
    headers: options.omitSignature
      ? { 'content-type': 'application/json' }
      : {
          'content-type': 'application/json',
          'stripe-signature': options.signature ?? 't=1,v1=deadbeef',
        },
    body,
    isBase64Encoded: Boolean(options.base64),
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'example.com',
      domainPrefix: 'example',
      http: {
        method: options.method ?? 'POST',
        path: '/billing/stripe-webhook',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'Stripe/1.0',
      },
      requestId: 'req-stripe-webhook',
      routeKey: 'POST /billing/stripe-webhook',
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
    },
  } as unknown as APIGatewayProxyEventV2;
}

function entitlementRow(overrides: Partial<StoredEntitlement> = {}): Record<string, unknown> {
  return {
    PK: `USER#${UID}`,
    SK: 'ENTITLEMENT#2026-10-01T00:00:00.000Z#evt_prior',
    entityType: 'ENTITLEMENT',
    userId: UID,
    tier: 'BASIC',
    status: 'ACTIVE',
    store: 'STRIPE',
    source: 'stripe',
    expiresAt: '2026-11-01T00:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('POST /billing/stripe-webhook (WARDROBE-190)', () => {
  const retrieve = jest.fn();
  const customersRetrieve = jest.fn();
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPutItem.mockResolvedValue(undefined);
    mockPutItemIfNotExists.mockResolvedValue(true);
    mockGetItem.mockResolvedValue(undefined);
    mockQueryByPk.mockResolvedValue([]);
    mockDeleteItem.mockResolvedValue(undefined);
    retrieve.mockResolvedValue(subscription());
    customersRetrieve.mockResolvedValue({ id: CUS_ID, metadata: { uid: UID } });
  });

  function deps() {
    return {
      loadConfig: async () => stripeConfig(),
      getStripeClient: async () => ({
        subscriptions: { retrieve },
        customers: { retrieve: customersRetrieve },
      }),
      log,
    };
  }

  it('verifies a valid signature against decoded raw bytes and grants premium', async () => {
    const { payload, signature } = signedPayload(
      stripeEventObject({ type: 'customer.subscription.created' }),
    );

    const result = asResult(
      await handleStripeWebhook(
        webhookEvent({ payload, signature, base64: true }),
        deps(),
      ),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual(
      expect.objectContaining({
        status: 'applied',
        tier: 'premium',
        eventId: EVENT_ID,
      }),
    );
    expect(retrieve).toHaveBeenCalledWith(SUB_ID, {
      expand: ['items.data.price', 'customer'],
    });
    expect(mockPutItem).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 'PREMIUM',
        source: 'stripe',
        store: 'STRIPE',
        status: 'ACTIVE',
        expiresAt: new Date(PERIOD_END * 1000).toISOString(),
      }),
    );
    expect(mockPutItemIfNotExists).toHaveBeenCalled();
  });

  it('returns 400 on a bad signature and writes nothing to DynamoDB', async () => {
    const { payload } = signedPayload(
      stripeEventObject({ type: 'customer.subscription.created' }),
    );
    const parse = jest.spyOn(JSON, 'parse');

    const result = asResult(
      await handleStripeWebhook(
        webhookEvent({ payload, signature: 't=1,v1=notavalidsignature' }),
        deps(),
      ),
    );

    expect(result.statusCode).toBe(400);
    expect(bodyOf(result)).toEqual({
      error: expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: 'Invalid Stripe webhook signature.',
      }),
    });
    expect(mockPutItem).not.toHaveBeenCalled();
    expect(mockPutItemIfNotExists).not.toHaveBeenCalled();
    expect(mockDeleteItem).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    expect(
      parse.mock.calls.some(
        ([value]) => value === payload || value === Buffer.from(payload).toString('utf8'),
      ),
    ).toBe(false);
    parse.mockRestore();
  });

  it('returns 400 on a missing signature and writes nothing to DynamoDB', async () => {
    const { payload } = signedPayload(
      stripeEventObject({ type: 'checkout.session.completed' }),
    );

    const result = asResult(
      await handleStripeWebhook(
        webhookEvent({ payload, omitSignature: true }),
        deps(),
      ),
    );

    expect(result.statusCode).toBe(400);
    expect(bodyOf(result)).toEqual({
      error: expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: 'Missing Stripe-Signature header.',
      }),
    });
    expect(mockPutItem).not.toHaveBeenCalled();
    expect(mockPutItemIfNotExists).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('skips a repeated event id and returns 200 without applying again', async () => {
    mockPutItemIfNotExists.mockResolvedValueOnce(false);
    const { payload, signature } = signedPayload(
      stripeEventObject({ type: 'customer.subscription.updated' }),
    );

    const result = asResult(
      await handleStripeWebhook(webhookEvent({ payload, signature }), deps()),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual({ status: 'duplicate', eventId: EVENT_ID });
    expect(retrieve).not.toHaveBeenCalled();
    expect(mockPutItem).not.toHaveBeenCalled();
  });

  it('keeps an active store plan on a Stripe clash and returns 200', async () => {
    mockQueryByPk.mockResolvedValue([
      entitlementRow({
        tier: 'PREMIUM',
        store: 'APP_STORE',
        source: 'ios',
      }),
    ]);
    const { payload, signature } = signedPayload(
      stripeEventObject({
        type: 'checkout.session.completed',
        object: {
          id: 'cs_test_1',
          object: 'checkout.session',
          subscription: SUB_ID,
          customer: CUS_ID,
        },
      }),
    );

    const result = asResult(
      await handleStripeWebhook(webhookEvent({ payload, signature }), deps()),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual(
      expect.objectContaining({ status: 'clash', reason: 'source_clash' }),
    );
    expect(mockPutItem).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Paid-tier source clash; keeping existing plan',
      expect.objectContaining({
        uid: UID,
        existingSource: 'ios',
        stripeSubscriptionId: SUB_ID,
      }),
    );
    const serialized = JSON.stringify(log.warn.mock.calls);
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain(WEBHOOK_SECRET);
  });

  it('applies a same-source upgrade from basic to premium', async () => {
    mockQueryByPk.mockResolvedValue([entitlementRow()]);
    retrieve.mockResolvedValue(subscription());
    const { payload, signature } = signedPayload(
      stripeEventObject({ type: 'customer.subscription.updated' }),
    );

    const result = asResult(
      await handleStripeWebhook(webhookEvent({ payload, signature }), deps()),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual(
      expect.objectContaining({ status: 'applied', reason: 'upgraded', tier: 'premium' }),
    );
    expect(mockPutItem).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 'PREMIUM',
        source: 'stripe',
        store: 'STRIPE',
      }),
    );
  });

  it('clears a Stripe paid tier on subscription cancel', async () => {
    mockQueryByPk.mockResolvedValue([
      entitlementRow({ tier: 'PREMIUM', source: 'stripe', store: 'STRIPE' }),
    ]);
    retrieve.mockResolvedValue(subscription({ status: 'canceled' }));
    const { payload, signature } = signedPayload(
      stripeEventObject({ type: 'customer.subscription.deleted' }),
    );

    const result = asResult(
      await handleStripeWebhook(webhookEvent({ payload, signature }), deps()),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual(
      expect.objectContaining({ status: 'cleared', reason: 'cleared' }),
    );
    expect(mockPutItem).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 'FREE',
        status: 'EXPIRED',
        source: 'stripe',
      }),
    );
  });

  it('does not clear an ios plan when Stripe reports canceled', async () => {
    mockQueryByPk.mockResolvedValue([
      entitlementRow({
        tier: 'PREMIUM',
        store: 'APP_STORE',
        source: 'ios',
      }),
    ]);
    retrieve.mockResolvedValue(subscription({ status: 'canceled' }));
    const { payload, signature } = signedPayload(
      stripeEventObject({ type: 'customer.subscription.deleted' }),
    );

    const result = asResult(
      await handleStripeWebhook(webhookEvent({ payload, signature }), deps()),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual(
      expect.objectContaining({ status: 'ignored', reason: 'not_stripe' }),
    );
    expect(mockPutItem).not.toHaveBeenCalled();
  });

  it('never logs the secret key, webhook secret, or signature', async () => {
    const { payload, signature } = signedPayload(
      stripeEventObject({ type: 'customer.subscription.created' }),
    );

    await handleStripeWebhook(webhookEvent({ payload, signature }), deps());

    const serialized = JSON.stringify({
      info: log.info.mock.calls,
      warn: log.warn.mock.calls,
      error: log.error.mock.calls,
    });
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain(WEBHOOK_SECRET);
    expect(serialized).not.toContain(signature);
    expect(serialized).not.toContain('sk_test_');
    expect(serialized).not.toContain('whsec_');
  });

  it('handles every subscribed Stripe event type', () => {
    expect(STRIPE_WEBHOOK_EVENT_TYPES).toEqual([
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
    ]);
  });
});
