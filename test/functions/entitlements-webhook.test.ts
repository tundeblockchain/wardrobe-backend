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

const ACCOUNT_A = 'firebase-uid-account-a';
const ACCOUNT_B = 'firebase-uid-account-b';
const TXN_A = 'txn_account_a';
const TXN_B = 'txn_account_b';

describe('Superwall entitlements webhook (WARDROBE-91)', () => {
  const loadConfig = jest.fn();
  const loadStored = jest.fn();
  const save = jest.fn();
  const loadTransactionOwner = jest.fn();
  const bindOwner = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    loadConfig.mockResolvedValue({
      webhookSecret: SECRET,
      productTiers: {},
    });
    loadStored.mockResolvedValue(undefined);
    save.mockResolvedValue(undefined);
    loadTransactionOwner.mockResolvedValue(undefined);
    bindOwner.mockResolvedValue(true);
  });

  function deps() {
    return {
      loadConfig,
      loadStored,
      save,
      loadTransactionOwner,
      bindTransactionOwner: bindOwner,
      nowSeconds: Number(TIMESTAMP),
    };
  }

  it('verifies Svix and stores PREMIUM for the Firebase UID', async () => {
    const result = asResult(
      await handleSuperwallWebhook(webhookEvent({ payload: purchasePayload() }), deps()),
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
      await handleSuperwallWebhook(webhookEvent({ payload }), deps()),
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
      await handleSuperwallWebhook(webhookEvent({ payload: purchasePayload() }), deps()),
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
        deps(),
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
        deps(),
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

describe('Superwall purchase identity (WARDROBE-165)', () => {
  const loadConfig = jest.fn();
  const loadStored = jest.fn();
  const save = jest.fn();
  const loadTransactionOwner = jest.fn();
  const bindOwner = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    loadConfig.mockResolvedValue({
      webhookSecret: SECRET,
      productTiers: {},
    });
    loadStored.mockResolvedValue(undefined);
    save.mockResolvedValue(undefined);
    loadTransactionOwner.mockResolvedValue(undefined);
    bindOwner.mockResolvedValue(true);
  });

  function deps() {
    return {
      loadConfig,
      loadStored,
      save,
      loadTransactionOwner,
      bindTransactionOwner: bindOwner,
      nowSeconds: Number(TIMESTAMP),
    };
  }

  it('grants B only when A already subscribed and B has a new purchase', async () => {
    loadTransactionOwner.mockImplementation(async (txnId: string) =>
      txnId === TXN_A ? ACCOUNT_A : undefined,
    );

    const payload = purchasePayload({
      id: 'evt_purchase_b',
      originalAppUserId: ACCOUNT_A,
      originalTransactionId: TXN_B,
      userAttributes: { firebaseUid: ACCOUNT_B },
    });

    const result = asResult(
      await handleSuperwallWebhook(webhookEvent({ payload }), deps()),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual({
      status: 'applied',
      eventName: 'initial_purchase',
      tier: 'PREMIUM',
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ACCOUNT_B,
        tier: 'PREMIUM',
        status: 'ACTIVE',
        originalTransactionId: TXN_B,
      }),
    );
    expect(save).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: ACCOUNT_A }),
    );
    expect(bindOwner).toHaveBeenCalledWith(TXN_B, ACCOUNT_B);
    expect(loadStored).toHaveBeenCalledWith(ACCOUNT_B);
    expect(loadStored).not.toHaveBeenCalledWith(ACCOUNT_A);
  });

  it('does not grant B A\'s receipt after an account switch', async () => {
    loadTransactionOwner.mockResolvedValue(ACCOUNT_A);

    const payload = purchasePayload({
      id: 'evt_restore_a_on_b',
      originalAppUserId: ACCOUNT_A,
      originalTransactionId: TXN_A,
      userAttributes: { firebaseUid: ACCOUNT_B },
    });

    const result = asResult(
      await handleSuperwallWebhook(webhookEvent({ payload }), deps()),
    );

    expect(bodyOf(result)).toEqual({
      status: 'ignored',
      reason: 'transaction_owned_by_other_user',
    });
    expect(save).not.toHaveBeenCalled();
    expect(bindOwner).not.toHaveBeenCalled();
  });

  it('does not flip B to Premium on cancel or billing failure', async () => {
    const cancelPayload = purchasePayload({
      id: 'evt_cancel_b',
      name: 'cancellation',
      originalAppUserId: ACCOUNT_B,
      originalTransactionId: TXN_B,
      userAttributes: { firebaseUid: ACCOUNT_B },
    });
    const cancelBody = JSON.parse(cancelPayload) as {
      type: string;
      data: Record<string, unknown>;
    };
    cancelBody.type = 'cancellation';

    const canceled = asResult(
      await handleSuperwallWebhook(
        webhookEvent({ payload: JSON.stringify(cancelBody) }),
        deps(),
      ),
    );

    expect(canceled.statusCode).toBe(200);
    expect(bodyOf(canceled)).toEqual({
      status: 'applied',
      eventName: 'cancellation',
      tier: 'FREE',
    });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ACCOUNT_B,
        tier: 'FREE',
        status: 'CANCELED',
      }),
    );
    expect(bindOwner).not.toHaveBeenCalled();

    save.mockClear();
    bindOwner.mockClear();

    const failBody = JSON.parse(purchasePayload({
      id: 'evt_fail_b',
      name: 'billing_issue',
      originalAppUserId: ACCOUNT_B,
      userAttributes: { firebaseUid: ACCOUNT_B },
    })) as { type: string; data: Record<string, unknown> };
    failBody.type = 'billing_issue';

    const failed = asResult(
      await handleSuperwallWebhook(
        webhookEvent({ payload: JSON.stringify(failBody) }),
        deps(),
      ),
    );

    expect(bodyOf(failed)).toEqual({
      status: 'applied',
      eventName: 'billing_issue',
      tier: 'FREE',
    });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ACCOUNT_B,
        tier: 'FREE',
        status: 'BILLING_ISSUE',
      }),
    );
    expect(bindOwner).not.toHaveBeenCalled();
  });
});

describe('Superwall device identity (WARDROBE-166)', () => {
  const DEVICE_ID = '7152E89E-60A6-4B2E-9C67-D7ED8F5BE372';
  const ANON_ID = `$SuperwallAlias:${DEVICE_ID}`;
  const loadConfig = jest.fn();
  const loadStored = jest.fn();
  const save = jest.fn();
  const loadTransactionOwner = jest.fn();
  const bindOwner = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    loadConfig.mockResolvedValue({
      webhookSecret: SECRET,
      productTiers: {},
    });
    loadStored.mockResolvedValue(undefined);
    save.mockResolvedValue(undefined);
    loadTransactionOwner.mockResolvedValue(undefined);
    bindOwner.mockResolvedValue(true);
  });

  function deps() {
    return {
      loadConfig,
      loadStored,
      save,
      loadTransactionOwner,
      bindTransactionOwner: bindOwner,
      nowSeconds: Number(TIMESTAMP),
    };
  }

  it('grants only the Firebase uid when appUserId is a device or anonymous id', async () => {
    const payload = purchasePayload({
      id: 'evt_purchase_device_plus_uid',
      originalAppUserId: ACCOUNT_A,
      appUserId: DEVICE_ID,
      originalTransactionId: TXN_B,
      userAttributes: { firebaseUid: ACCOUNT_B },
    });

    const result = asResult(
      await handleSuperwallWebhook(webhookEvent({ payload }), deps()),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual({
      status: 'applied',
      eventName: 'initial_purchase',
      tier: 'PREMIUM',
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ACCOUNT_B,
        tier: 'PREMIUM',
        status: 'ACTIVE',
        originalTransactionId: TXN_B,
      }),
    );
    expect(save).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: DEVICE_ID }),
    );
    expect(save).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: ACCOUNT_A }),
    );
    expect(bindOwner).toHaveBeenCalledWith(TXN_B, ACCOUNT_B);
    expect(loadStored).toHaveBeenCalledWith(ACCOUNT_B);
    expect(loadStored).not.toHaveBeenCalledWith(DEVICE_ID);
    expect(loadStored).not.toHaveBeenCalledWith(ACCOUNT_A);
  });

  it('does not grant Premium when the only identity is a device or anonymous id', async () => {
    const deviceOnly = asResult(
      await handleSuperwallWebhook(
        webhookEvent({
          payload: purchasePayload({
            id: 'evt_device_only',
            originalAppUserId: DEVICE_ID,
            appUserId: DEVICE_ID,
            originalTransactionId: TXN_B,
          }),
        }),
        deps(),
      ),
    );

    expect(deviceOnly.statusCode).toBe(200);
    expect(bodyOf(deviceOnly)).toEqual({
      status: 'ignored',
      reason: 'unknown_user',
    });
    expect(save).not.toHaveBeenCalled();
    expect(bindOwner).not.toHaveBeenCalled();

    const anonOnly = asResult(
      await handleSuperwallWebhook(
        webhookEvent({
          payload: purchasePayload({
            id: 'evt_anon_only',
            originalAppUserId: ANON_ID,
            appUserId: ANON_ID,
            originalTransactionId: TXN_B,
          }),
        }),
        deps(),
      ),
    );

    expect(bodyOf(anonOnly)).toEqual({
      status: 'ignored',
      reason: 'unknown_user',
    });
    expect(save).not.toHaveBeenCalled();
    expect(bindOwner).not.toHaveBeenCalled();
  });

  it('does not grant A when B pays on a device that previously had A', async () => {
    loadTransactionOwner.mockImplementation(async (txnId: string) =>
      txnId === TXN_A ? ACCOUNT_A : undefined,
    );

    const grantedB = asResult(
      await handleSuperwallWebhook(
        webhookEvent({
          payload: purchasePayload({
            id: 'evt_b_on_shared_device',
            originalAppUserId: ACCOUNT_A,
            appUserId: DEVICE_ID,
            originalTransactionId: TXN_B,
            userAttributes: { firebaseUid: ACCOUNT_B },
          }),
        }),
        deps(),
      ),
    );

    expect(bodyOf(grantedB)).toEqual({
      status: 'applied',
      eventName: 'initial_purchase',
      tier: 'PREMIUM',
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ACCOUNT_B,
        tier: 'PREMIUM',
        originalTransactionId: TXN_B,
      }),
    );
    expect(save).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: ACCOUNT_A }),
    );
    expect(bindOwner).toHaveBeenCalledWith(TXN_B, ACCOUNT_B);

    save.mockClear();
    bindOwner.mockClear();

    const noUidForB = asResult(
      await handleSuperwallWebhook(
        webhookEvent({
          payload: purchasePayload({
            id: 'evt_device_stale_a',
            originalAppUserId: ACCOUNT_A,
            appUserId: DEVICE_ID,
            originalTransactionId: TXN_B,
          }),
        }),
        deps(),
      ),
    );

    expect(bodyOf(noUidForB)).toEqual({
      status: 'ignored',
      reason: 'unknown_user',
    });
    expect(save).not.toHaveBeenCalled();
    expect(bindOwner).not.toHaveBeenCalled();
  });
});
