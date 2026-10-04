import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { handleSuperwallWebhook } from '../../src/functions/entitlements-webhook/handler';
import { signSvixWebhook } from '../../src/shared/svix';
import {
  deriveSuperwallAppUserId,
  StoredEntitlement,
} from '../../src/shared/entitlements';
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
      originalAppUserId: deriveSuperwallAppUserId(OWNER_ID),
      userAttributes: { firebaseUid: OWNER_ID },
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
      userAttributes: { firebaseUid: OWNER_ID },
    });
    const result = asResult(
      await handleSuperwallWebhook(webhookEvent({ payload }), deps()),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual({
      status: 'ignored',
      reason: 'app_user_id_mismatch',
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

describe('Superwall derived app user id (WARDROBE-167)', () => {
  const UID_A = 'uid-a';
  const UID_B = 'uid-b';
  const UID_A_APP_USER_ID = '87fd3c93-5175-41f0-9dda-2884927fbc28';
  const UID_B_APP_USER_ID = deriveSuperwallAppUserId(UID_B);
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

  function signedIn(uid: string, extra: Record<string, unknown> = {}) {
    return superwallSdkAttributes({
      appUserId: deriveSuperwallAppUserId(uid),
      firebaseUid: uid,
      ...extra,
    });
  }

  function expectNothingWritten() {
    expect(save).not.toHaveBeenCalled();
    expect(bindOwner).not.toHaveBeenCalled();
  }

  it('documented payload has no data.appUserId', () => {
    expect(iosSuperwallEvent().data).not.toHaveProperty('appUserId');
  });

  it.each([
    ['lowercase', UID_A_APP_USER_ID],
    ['uppercase', UID_A_APP_USER_ID.toUpperCase()],
  ])('grants uid-a only when originalAppUserId is its derived id (%s)', async (_case, original) => {
    expect(deriveSuperwallAppUserId(UID_A)).toBe(UID_A_APP_USER_ID);

    const result = await send(
      iosSuperwallEvent({ originalAppUserId: original, userAttributes: signedIn(UID_A) }),
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
        userId: UID_A,
        tier: 'PREMIUM',
        status: 'ACTIVE',
        store: 'APP_STORE',
        originalTransactionId: '700002050981465',
      }),
    );
    expect(bindOwner).toHaveBeenCalledWith('700002050981465', UID_A);
    expect(loadStored).toHaveBeenCalledWith(UID_A);
    for (const id of [IOS_DEVICE_ID, IOS_ALIAS_ID, original]) {
      expect(save).not.toHaveBeenCalledWith(expect.objectContaining({ userId: id }));
      expect(loadStored).not.toHaveBeenCalledWith(id);
    }
  });

  it.each([
    ['device UUID', IOS_DEVICE_ID],
    ['lowercase device UUID', IOS_DEVICE_ID.toLowerCase()],
    ['$SuperwallAlias', IOS_ALIAS_ID],
    ['raw Firebase uid', UID_A],
    ['null', null],
  ])('grants nobody when originalAppUserId is a %s, even with firebaseUid set', async (_case, original) => {
    const result = await send(
      iosSuperwallEvent({ originalAppUserId: original, userAttributes: signedIn(UID_A) }),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual({ status: 'ignored', reason: 'app_user_id_mismatch' });
    expectNothingWritten();
    expect(loadStored).not.toHaveBeenCalled();
  });

  it('grants nobody when firebaseUid is missing, even if originalAppUserId is a derived id', async () => {
    const result = await send(
      iosSuperwallEvent({
        originalAppUserId: UID_A_APP_USER_ID,
        userAttributes: superwallSdkAttributes({ appUserId: UID_A_APP_USER_ID }),
      }),
    );

    expect(bodyOf(result)).toEqual({ status: 'ignored', reason: 'unknown_user' });
    expectNothingWritten();
  });

  it('does not copy or rebind an old receipt bound to a device alias onto the new uid', async () => {
    loadTransactionOwner.mockResolvedValue(IOS_ALIAS_ID);

    const preBuild = await send(
      iosSuperwallEvent({
        name: 'renewal',
        originalAppUserId: IOS_ALIAS_ID,
        userAttributes: signedIn(UID_A),
      }),
    );
    expect(bodyOf(preBuild)).toEqual({ status: 'ignored', reason: 'app_user_id_mismatch' });

    const derivedOnOldReceipt = await send(
      iosSuperwallEvent({
        originalAppUserId: UID_A_APP_USER_ID,
        userAttributes: signedIn(UID_A),
      }),
    );
    expect(bodyOf(derivedOnOldReceipt)).toEqual({
      status: 'ignored',
      reason: 'transaction_owned_by_other_user',
    });

    expectNothingWritten();
  });

  it('grants only the account whose derived id matches when two accounts share a device', async () => {
    loadTransactionOwner.mockImplementation(async (txnId: string) =>
      txnId === TXN_A ? UID_A : undefined,
    );

    const bPaid = await send(
      iosSuperwallEvent({
        id: 'evt_b_paid',
        originalAppUserId: UID_B_APP_USER_ID,
        originalTransactionId: TXN_B,
        userAttributes: signedIn(UID_B),
      }),
    );
    expect(bodyOf(bPaid)).toEqual({
      status: 'applied',
      eventName: 'initial_purchase',
      tier: 'PREMIUM',
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ userId: UID_B, tier: 'PREMIUM', originalTransactionId: TXN_B }),
    );
    expect(save).not.toHaveBeenCalledWith(expect.objectContaining({ userId: UID_A }));
    expect(bindOwner).toHaveBeenCalledWith(TXN_B, UID_B);

    jest.clearAllMocks();
    const bOnAsReceipt = await send(
      iosSuperwallEvent({
        id: 'evt_a_renewal_b_signed_in',
        name: 'renewal',
        originalAppUserId: UID_A_APP_USER_ID,
        originalTransactionId: TXN_A,
        userAttributes: signedIn(UID_B),
      }),
    );
    expect(bodyOf(bOnAsReceipt)).toEqual({
      status: 'ignored',
      reason: 'app_user_id_mismatch',
    });
    expectNothingWritten();

    const bOnAsOldAlias = await send(
      iosSuperwallEvent({
        id: 'evt_old_alias_b_signed_in',
        name: 'renewal',
        originalAppUserId: IOS_ALIAS_ID,
        originalTransactionId: TXN_A,
        userAttributes: signedIn(UID_B),
      }),
    );
    expect(bodyOf(bOnAsOldAlias)).toEqual({
      status: 'ignored',
      reason: 'app_user_id_mismatch',
    });
    expectNothingWritten();
  });

  it('does not let B take A\'s receipt even with a matching derived id', async () => {
    loadTransactionOwner.mockResolvedValue(UID_A);
    const result = await send(
      iosSuperwallEvent({
        originalAppUserId: UID_B_APP_USER_ID,
        originalTransactionId: TXN_A,
        userAttributes: signedIn(UID_B),
      }),
    );
    expect(bodyOf(result)).toEqual({
      status: 'ignored',
      reason: 'transaction_owned_by_other_user',
    });
    expectNothingWritten();
  });

  it('grants nobody when firebaseUid and firebase_uid disagree', async () => {
    const result = await send(
      iosSuperwallEvent({
        originalAppUserId: UID_A_APP_USER_ID,
        userAttributes: signedIn(UID_A, { firebase_uid: UID_B }),
      }),
    );
    expect(bodyOf(result)).toEqual({ status: 'ignored', reason: 'ambiguous_user' });
    expectNothingWritten();
  });

  it('never flips anyone to Premium on cancellation or billing issue', async () => {
    for (const name of ['cancellation', 'billing_issue']) {
      jest.clearAllMocks();
      const matched = await send(
        iosSuperwallEvent({
          id: `evt_${name}`,
          name,
          originalAppUserId: UID_A_APP_USER_ID,
          userAttributes: signedIn(UID_A),
        }),
      );
      expect(bodyOf(matched)).toEqual({ status: 'applied', eventName: name, tier: 'FREE' });
      expect(save).not.toHaveBeenCalledWith(expect.objectContaining({ tier: 'PREMIUM' }));
      expect(bindOwner).not.toHaveBeenCalled();

      jest.clearAllMocks();
      const alias = await send(
        iosSuperwallEvent({ id: `evt_${name}_alias`, name, userAttributes: signedIn(UID_A) }),
      );
      expect(bodyOf(alias)).toEqual({ status: 'ignored', reason: 'app_user_id_mismatch' });
      expectNothingWritten();
    }
  });

  it('appends a history row per event and the latest row wins (WARDROBE-159)', async () => {
    const rows: StoredEntitlement[] = [];
    save.mockImplementation(async (stored: StoredEntitlement) => {
      rows.push(stored);
    });
    loadStored.mockImplementation(async () => rows[rows.length - 1]);
    const event = (id: string, name: string, offset: number) =>
      iosSuperwallEvent({
        id,
        name,
        purchasedAt: Date.parse('2026-10-04T13:00:00.000Z') + offset,
        originalAppUserId: UID_A_APP_USER_ID,
        userAttributes: signedIn(UID_A),
      });

    await send(event('evt_1', 'initial_purchase', 0));
    await send(event('evt_2', 'cancellation', 1000));
    const resubscribed = await send(event('evt_3', 'uncancellation', 2000));

    expect(rows.map((row) => row.status)).toEqual(['ACTIVE', 'CANCELED', 'ACTIVE']);
    expect(rows.every((row) => row.userId === UID_A)).toBe(true);
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
