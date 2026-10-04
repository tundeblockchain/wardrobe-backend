import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { handleSuperwallWebhook } from '../../src/functions/entitlements-webhook/handler';
import { signSvixWebhook } from '../../src/shared/svix';
import { StoredEntitlement } from '../../src/shared/entitlements';
import {
  IOS_ALIAS_ID,
  IOS_DEVICE_ID,
  iosSuperwallEvent,
  superwallSdkAttributes,
} from '../helpers/superwall-payloads';

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
      originalAppUserId: '$SuperwallAlias:7152E89E-60A6-4B2E-9C67-D7ED8F5BE372',
      userAttributes: { appUserId: OWNER_ID },
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
      userAttributes: { aliasId: '$SuperwallAlias:unknown' },
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
            userAttributes: { aliasId: ANON_ID, appUserId: DEVICE_ID },
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
            userAttributes: { aliasId: ANON_ID },
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
            userAttributes: { aliasId: ANON_ID },
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

describe('Superwall iOS Gmail purchase, documented payload shape (WARDROBE-167)', () => {
  const GMAIL_UID = 'Xq3pT9bLw2MZkV7rHd5sNc1yFa84';
  const loadConfig = jest.fn();
  const loadStored = jest.fn();
  const save = jest.fn();
  const loadTransactionOwner = jest.fn();
  const bindOwner = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    loadConfig.mockResolvedValue({ webhookSecret: SECRET, productTiers: {} });
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

  async function send(body: unknown) {
    return asResult(
      await handleSuperwallWebhook(
        webhookEvent({ payload: JSON.stringify(body) }),
        deps(),
      ),
    );
  }

  function expectNoDeviceWrites() {
    for (const id of [IOS_DEVICE_ID, IOS_ALIAS_ID]) {
      expect(save).not.toHaveBeenCalledWith(expect.objectContaining({ userId: id }));
      expect(loadStored).not.toHaveBeenCalledWith(id);
      expect(bindOwner).not.toHaveBeenCalledWith(expect.anything(), id);
    }
  }

  it('documented payload has no data.appUserId and an alias originalAppUserId', () => {
    const { data } = iosSuperwallEvent();
    expect(data).not.toHaveProperty('appUserId');
    expect(data.originalAppUserId).toBe(IOS_ALIAS_ID);
  });

  it('grants the Firebase uid the SDK identified, not the device id', async () => {
    const result = await send(
      iosSuperwallEvent({
        userAttributes: superwallSdkAttributes({ appUserId: GMAIL_UID }),
      }),
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
        userId: GMAIL_UID,
        tier: 'PREMIUM',
        status: 'ACTIVE',
        store: 'APP_STORE',
        originalTransactionId: '700002050981465',
      }),
    );
    expect(bindOwner).toHaveBeenCalledWith('700002050981465', GMAIL_UID);
    expectNoDeviceWrites();
  });

  it('grants userAttributes.firebaseUid when the SDK appUserId is the device id', async () => {
    const result = await send(
      iosSuperwallEvent({
        userAttributes: superwallSdkAttributes({
          appUserId: IOS_DEVICE_ID,
          firebaseUid: GMAIL_UID,
        }),
      }),
    );

    expect(bodyOf(result)).toEqual({
      status: 'applied',
      eventName: 'initial_purchase',
      tier: 'PREMIUM',
    });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ userId: GMAIL_UID, tier: 'PREMIUM' }),
    );
    expectNoDeviceWrites();
  });

  it.each([
    ['SDK attributes only', superwallSdkAttributes()],
    ['device UUID appUserId', superwallSdkAttributes({ appUserId: IOS_DEVICE_ID })],
    ['lowercase device UUID', superwallSdkAttributes({ appUserId: IOS_DEVICE_ID.toLowerCase() })],
    ['undashed device UUID', superwallSdkAttributes({ appUserId: IOS_DEVICE_ID.replace(/-/g, '') })],
    ['$SuperwallAlias appUserId', superwallSdkAttributes({ appUserId: IOS_ALIAS_ID })],
    ['$SuperwallAnonymous firebaseUid', superwallSdkAttributes({ firebaseUid: `$SuperwallAnonymous:${IOS_DEVICE_ID}` })],
    ['no userAttributes', undefined],
  ])('grants nobody when the only identity is a device id (%s)', async (_label, attrs) => {
    const body = iosSuperwallEvent({ userAttributes: attrs });
    if (attrs === undefined) {
      delete (body.data as { userAttributes?: unknown }).userAttributes;
    }
    const result = await send(body);

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual({ status: 'ignored', reason: 'unknown_user' });
    expect(save).not.toHaveBeenCalled();
    expect(bindOwner).not.toHaveBeenCalled();
    expect(loadStored).not.toHaveBeenCalled();
  });

  it('does not grant the receipt owner when the event carries no uid', async () => {
    loadTransactionOwner.mockResolvedValue(ACCOUNT_A);
    const fromA = await send(
      iosSuperwallEvent({ name: 'renewal', userAttributes: superwallSdkAttributes() }),
    );
    expect(bodyOf(fromA)).toEqual({ status: 'ignored', reason: 'unknown_user' });

    loadTransactionOwner.mockResolvedValue(IOS_DEVICE_ID);
    const fromDevice = await send(
      iosSuperwallEvent({
        name: 'renewal',
        userAttributes: superwallSdkAttributes({ appUserId: IOS_DEVICE_ID }),
      }),
    );
    expect(bodyOf(fromDevice)).toEqual({ status: 'ignored', reason: 'unknown_user' });

    expect(save).not.toHaveBeenCalled();
    expect(bindOwner).not.toHaveBeenCalled();
  });

  it('grants the Firebase uid when the receipt was bound to a device id before WARDROBE-166', async () => {
    loadTransactionOwner.mockResolvedValue(IOS_DEVICE_ID);
    const result = await send(
      iosSuperwallEvent({
        userAttributes: superwallSdkAttributes({ appUserId: GMAIL_UID }),
      }),
    );

    expect(bodyOf(result)).toEqual({
      status: 'applied',
      eventName: 'initial_purchase',
      tier: 'PREMIUM',
    });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ userId: GMAIL_UID }));
    expect(bindOwner).toHaveBeenCalledWith('700002050981465', GMAIL_UID);
    expectNoDeviceWrites();
  });

  it('grants only B when B pays on a device that had A, with originalAppUserId still A', async () => {
    loadTransactionOwner.mockImplementation(async (txnId: string) =>
      txnId === TXN_A ? ACCOUNT_A : undefined,
    );

    for (const original of [ACCOUNT_A, IOS_ALIAS_ID]) {
      jest.clearAllMocks();
      const result = await send(
        iosSuperwallEvent({
          id: `evt_b_${original}`,
          originalAppUserId: original,
          originalTransactionId: TXN_B,
          userAttributes: superwallSdkAttributes({ appUserId: ACCOUNT_B }),
        }),
      );

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
          originalTransactionId: TXN_B,
        }),
      );
      expect(save).not.toHaveBeenCalledWith(expect.objectContaining({ userId: ACCOUNT_A }));
      expect(loadStored).not.toHaveBeenCalledWith(ACCOUNT_A);
      expect(bindOwner).toHaveBeenCalledWith(TXN_B, ACCOUNT_B);
      expectNoDeviceWrites();
    }
  });

  it("does not copy A's Premium to B when B signs in and A's receipt renews", async () => {
    loadTransactionOwner.mockResolvedValue(ACCOUNT_A);
    const result = await send(
      iosSuperwallEvent({
        name: 'renewal',
        originalAppUserId: ACCOUNT_A,
        originalTransactionId: TXN_A,
        userAttributes: superwallSdkAttributes({ appUserId: ACCOUNT_B }),
      }),
    );

    expect(bodyOf(result)).toEqual({
      status: 'ignored',
      reason: 'transaction_owned_by_other_user',
    });
    expect(save).not.toHaveBeenCalled();
    expect(bindOwner).not.toHaveBeenCalled();
  });

  it('grants nobody when the payload carries two different Firebase uids', async () => {
    const result = await send(
      iosSuperwallEvent({
        userAttributes: superwallSdkAttributes({
          appUserId: ACCOUNT_A,
          firebaseUid: ACCOUNT_B,
        }),
      }),
    );

    expect(bodyOf(result)).toEqual({ status: 'ignored', reason: 'ambiguous_user' });
    expect(save).not.toHaveBeenCalled();
    expect(bindOwner).not.toHaveBeenCalled();
  });

  it('does not flip anyone to Premium on cancellation or billing issue', async () => {
    for (const name of ['cancellation', 'billing_issue']) {
      jest.clearAllMocks();
      const result = await send(
        iosSuperwallEvent({
          id: `evt_${name}`,
          name,
          userAttributes: superwallSdkAttributes({ appUserId: ACCOUNT_B }),
        }),
      );
      expect(bodyOf(result)).toEqual({ status: 'applied', eventName: name, tier: 'FREE' });
      expect(save).not.toHaveBeenCalledWith(expect.objectContaining({ tier: 'PREMIUM' }));
      expect(bindOwner).not.toHaveBeenCalled();

      jest.clearAllMocks();
      const deviceOnly = await send(
        iosSuperwallEvent({ id: `evt_${name}_device`, name }),
      );
      expect(bodyOf(deviceOnly)).toEqual({ status: 'ignored', reason: 'unknown_user' });
      expect(save).not.toHaveBeenCalled();
    }
  });

  it('appends a history row per event and the latest row wins (WARDROBE-159)', async () => {
    const rows: StoredEntitlement[] = [];
    save.mockImplementation(async (stored: StoredEntitlement) => {
      rows.push(stored);
    });
    loadStored.mockImplementation(async () => rows[rows.length - 1]);
    const attrs = superwallSdkAttributes({ appUserId: GMAIL_UID });
    const t0 = Date.parse('2026-10-04T13:00:00.000Z');

    await send(iosSuperwallEvent({ id: 'evt_1', purchasedAt: t0, userAttributes: attrs }));
    await send(
      iosSuperwallEvent({ id: 'evt_2', name: 'cancellation', purchasedAt: t0 + 1000, userAttributes: attrs }),
    );
    const resubscribed = await send(
      iosSuperwallEvent({ id: 'evt_3', name: 'uncancellation', purchasedAt: t0 + 2000, userAttributes: attrs }),
    );

    expect(rows.map((row) => row.status)).toEqual(['ACTIVE', 'CANCELED', 'ACTIVE']);
    expect(rows.every((row) => row.userId === GMAIL_UID)).toBe(true);
    expect(rows[rows.length - 1]).toEqual(
      expect.objectContaining({ tier: 'PREMIUM', status: 'ACTIVE', lastEventId: 'evt_3' }),
    );
    expect(bodyOf(resubscribed)).toEqual({
      status: 'applied',
      eventName: 'uncancellation',
      tier: 'PREMIUM',
    });
  });
});
