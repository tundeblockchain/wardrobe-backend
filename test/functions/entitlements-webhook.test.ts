import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { handleSuperwallWebhook } from '../../src/functions/entitlements-webhook/handler';
import { signSvixWebhook } from '../../src/shared/svix';
import { StoredEntitlement } from '../../src/shared/entitlements';

const SECRET = `whsec_${Buffer.from('unit-test-superwall-secret').toString('base64')}`;
const TIMESTAMP = '1710000000';
const ID = 'msg_superwall_1';
const OWNER_ID = 'firebase-uid-owner';

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

function webhookEvent(options: {
  payload: string;
  signature?: string;
  id?: string;
  timestamp?: string;
  omitHeaders?: boolean;
}): APIGatewayProxyEventV2 {
  const id = options.id ?? ID;
  const timestamp = options.timestamp ?? TIMESTAMP;
  const signature =
    options.signature ??
    signSvixWebhook({
      payload: options.payload,
      id,
      timestamp,
      webhookSecret: SECRET,
    });

  return {
    version: '2.0',
    routeKey: 'POST /webhooks/superwall',
    rawPath: '/webhooks/superwall',
    rawQueryString: '',
    headers: options.omitHeaders
      ? {}
      : {
          'svix-id': id,
          'svix-timestamp': timestamp,
          'svix-signature': signature,
        },
    body: options.payload,
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
      requestId: 'req-webhook',
      routeKey: 'POST /webhooks/superwall',
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
    },
  } as unknown as APIGatewayProxyEventV2;
}

function purchasePayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    object: 'event',
    type: 'initial_purchase',
    data: {
      id: 'evt_purchase_1',
      name: 'initial_purchase',
      productId: 'premium_monthly',
      originalAppUserId: OWNER_ID,
      store: 'APP_STORE',
      expirationAt: Date.parse('2026-10-16T00:00:00.000Z'),
      ...overrides,
    },
  });
}

describe('Superwall entitlements webhook (WARDROBE-91)', () => {
  const loadConfig = jest.fn();
  const loadStored = jest.fn();
  const save = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    loadConfig.mockResolvedValue({
      webhookSecret: SECRET,
      productTiers: {},
    });
    loadStored.mockResolvedValue(undefined);
    save.mockResolvedValue(undefined);
  });

  it('verifies Svix and stores PREMIUM for the Firebase UID', async () => {
    const result = asResult(
      await handleSuperwallWebhook(webhookEvent({ payload: purchasePayload() }), {
        loadConfig,
        loadStored,
        save,
        nowSeconds: Number(TIMESTAMP),
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual({
      status: 'applied',
      eventName: 'initial_purchase',
      tier: 'PREMIUM',
    });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: OWNER_ID,
        tier: 'PREMIUM',
        status: 'ACTIVE',
        productId: 'premium_monthly',
        store: 'APP_STORE',
      }),
    );
  });

  it('ignores events that cannot be mapped to a Firebase UID', async () => {
    const payload = purchasePayload({
      originalAppUserId: '$SuperwallAlias:unknown',
    });
    const result = asResult(
      await handleSuperwallWebhook(webhookEvent({ payload }), {
        loadConfig,
        loadStored,
        save,
        nowSeconds: Number(TIMESTAMP),
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual({
      status: 'ignored',
      reason: 'unknown_user',
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('skips duplicate event ids so restore webhooks are idempotent', async () => {
    const existing: StoredEntitlement = {
      userId: OWNER_ID,
      tier: 'PREMIUM',
      status: 'ACTIVE',
      lastEventId: 'evt_purchase_1',
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
    };
    loadStored.mockResolvedValue(existing);

    const result = asResult(
      await handleSuperwallWebhook(webhookEvent({ payload: purchasePayload() }), {
        loadConfig,
        loadStored,
        save,
        nowSeconds: Number(TIMESTAMP),
      }),
    );

    expect(bodyOf(result)).toEqual({
      status: 'duplicate',
      eventName: 'initial_purchase',
      tier: 'PREMIUM',
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature without leaking internals', async () => {
    const result = asResult(
      await handleSuperwallWebhook(
        webhookEvent({
          payload: purchasePayload(),
          signature: 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        }),
        {
          loadConfig,
          loadStored,
          save,
          nowSeconds: Number(TIMESTAMP),
        },
      ),
    );

    expect(result.statusCode).toBe(403);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid Superwall webhook signature.',
      },
    });
    expect(JSON.stringify(bodyOf(result))).not.toContain(SECRET);
    expect(save).not.toHaveBeenCalled();
  });

  it('returns 400 when Svix headers are missing', async () => {
    const result = asResult(
      await handleSuperwallWebhook(
        webhookEvent({ payload: purchasePayload(), omitHeaders: true }),
        {
          loadConfig,
          loadStored,
          save,
          nowSeconds: Number(TIMESTAMP),
        },
      ),
    );

    expect(result.statusCode).toBe(400);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Missing webhook signature headers.',
      },
    });
  });
});
