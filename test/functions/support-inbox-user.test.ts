import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { handleSupportInboxUser } from '../../src/functions/support-inbox/user-handler';
import { parseUserListQuery } from '../../src/functions/support-inbox/user-validation';
import {
  decodeExclusiveStartKey,
  encodeExclusiveStartKey,
} from '../../src/functions/support-inbox/cursor';
import {
  SupportNotFoundError,
  SupportValidationError,
} from '../../src/functions/support-inbox/http';
import {
  conversationUnread,
  conversationPatchAfterMessage,
  statusAfterUserFollowUp,
} from '../../src/functions/support-inbox/status';
import {
  hashDeviceToken,
  isConversationOwnedBy,
} from '../../src/functions/support-inbox/model';
import { parseDeviceBody, parseDeviceTokenBody } from '../../src/functions/support-inbox/validation';
import { countUnreadConversationsByUid } from '../../src/functions/support-inbox/table';
import { keys } from '../../src/functions/support-inbox/keys';
import { SUPPORT_PRESIGN_EXPIRES_SECONDS } from '../../src/shared/support-inbox-names';

const OWNER_TOKEN = 'owner-token';
const OTHER_TOKEN = 'other-token';
const INVALID_TOKEN = 'not.a.jwt';
const OWNER_UID = 'firebase-uid-owner';
const OTHER_UID = 'firebase-uid-other';

function asResult(
  result: Awaited<ReturnType<typeof handleSupportInboxUser>>,
): APIGatewayProxyStructuredResultV2 {
  if (typeof result === 'string') {
    throw new Error('expected a structured API Gateway result');
  }
  return result;
}

function bodyOf(result: APIGatewayProxyStructuredResultV2): unknown {
  return result.body ? JSON.parse(result.body) : undefined;
}

function event(options: {
  method: string;
  path: string;
  routeKey?: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  pathParameters?: Record<string, string>;
  authorization?: string | null;
}): APIGatewayProxyEventV2 {
  const headers: Record<string, string> = {};
  if (options.authorization === null) {
    // missing token
  } else if (options.authorization !== undefined) {
    headers.authorization = options.authorization.startsWith('Bearer ')
      ? options.authorization
      : `Bearer ${options.authorization}`;
  } else {
    headers.authorization = `Bearer ${OWNER_TOKEN}`;
  }

  const method = options.method;
  const path = options.path;
  return {
    version: '2.0',
    routeKey: options.routeKey ?? `${method} ${path}`,
    rawPath: path,
    rawQueryString: options.query
      ? new URLSearchParams(
          Object.entries(options.query).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ).toString()
      : '',
    headers,
    queryStringParameters: options.query,
    pathParameters: options.pathParameters,
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
        sourceIp: '203.0.113.9',
        userAgent: 'jest',
      },
      requestId: 'req-1',
      routeKey: options.routeKey ?? `${method} ${path}`,
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

const USER_ROUTES: Array<{
  name: string;
  method: string;
  path: string;
  routeKey: string;
  pathParameters?: Record<string, string>;
  body?: unknown;
}> = [
  {
    name: 'register-device',
    method: 'POST',
    path: '/support/devices',
    routeKey: 'POST /support/devices',
    body: { token: 'fcm-token', platform: 'ios' },
  },
  {
    name: 'delete-device',
    method: 'DELETE',
    path: '/support/devices',
    routeKey: 'DELETE /support/devices',
    body: { token: 'fcm-token' },
  },
  {
    name: 'list',
    method: 'GET',
    path: '/support/my/conversations',
    routeKey: 'GET /support/my/conversations',
  },
  {
    name: 'thread',
    method: 'GET',
    path: '/support/my/conversations/conv_1',
    routeKey: 'GET /support/my/conversations/{id}',
    pathParameters: { id: 'conv_1' },
  },
  {
    name: 'follow-up',
    method: 'POST',
    path: '/support/my/conversations/conv_1/messages',
    routeKey: 'POST /support/my/conversations/{id}/messages',
    pathParameters: { id: 'conv_1' },
    body: { message: 'Still broken.' },
  },
];

function ownedMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    PK: 'CONV#conv_1',
    SK: 'META',
    entityType: 'CONVERSATION',
    conversationId: 'conv_1',
    status: 'replied',
    type: 'bug',
    email: 'user@example.com',
    platform: 'ios',
    uid: OWNER_UID,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastMessageAt: '2026-01-02T00:00:00.000Z',
    lastMessagePreview: 'Thanks for writing in.',
    lastMessageAuthor: 'admin',
    lastAdminMessageAt: '2026-01-02T00:00:00.000Z',
    screenshotKey: 'support/shot.png',
    ...overrides,
  };
}

describe('support inbox user helpers (WARDROBE-286)', () => {
  it('defaults list limit to 50 and validates 1..100', () => {
    expect(parseUserListQuery(undefined)).toEqual({ limit: 50 });
    expect(parseUserListQuery({ limit: '1' })).toEqual({ limit: 1 });
    expect(parseUserListQuery({ limit: '100' })).toEqual({ limit: 100 });
    expect(() => parseUserListQuery({ limit: '0' })).toThrow(SupportValidationError);
    expect(() => parseUserListQuery({ limit: '101' })).toThrow(SupportValidationError);
  });

  it('round-trips an opaque LastEvaluatedKey cursor', () => {
    const key = {
      PK: 'CONV#conv_1',
      SK: 'META',
      uid: OWNER_UID,
      lastMessageAt: '2026-01-02T00:00:00.000Z',
    };
    const cursor = encodeExclusiveStartKey(key);
    expect(cursor).toEqual(expect.any(String));
    expect(decodeExclusiveStartKey(cursor as string)).toEqual(key);
    expect(parseUserListQuery({ cursor: cursor as string })).toEqual({
      limit: 50,
      exclusiveStartKey: key,
    });
  });

  it('rejects a malformed cursor', () => {
    expect(() => parseUserListQuery({ cursor: 'not-base64-json' })).toThrow(
      SupportValidationError,
    );
    expect(() => parseUserListQuery({ cursor: 'e30=' })).toThrow(SupportValidationError);
  });

  it('marks unread only when the latest admin message is newer than lastReadAt', () => {
    expect(
      conversationUnread({
        lastMessageAuthor: 'admin',
        lastMessageAt: '2026-01-02T00:00:00.000Z',
        lastAdminMessageAt: '2026-01-02T00:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      conversationUnread({
        lastMessageAuthor: 'admin',
        lastMessageAt: '2026-01-02T00:00:00.000Z',
        lastAdminMessageAt: '2026-01-02T00:00:00.000Z',
        lastReadAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      conversationUnread({
        lastMessageAuthor: 'admin',
        lastMessageAt: '2026-01-02T00:00:00.000Z',
        lastAdminMessageAt: '2026-01-02T00:00:00.000Z',
        lastReadAt: '2026-01-02T00:00:00.000Z',
      }),
    ).toBe(false);
    expect(
      conversationUnread({
        lastMessageAuthor: 'user',
        lastMessageAt: '2026-01-03T00:00:00.000Z',
        lastAdminMessageAt: '2026-01-02T00:00:00.000Z',
        lastReadAt: '2026-01-02T12:00:00.000Z',
      }),
    ).toBe(false);
    expect(
      conversationUnread({
        lastMessageAuthor: 'user',
        lastMessageAt: '2026-01-03T00:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('reopens a closed conversation on user follow-up', () => {
    expect(statusAfterUserFollowUp()).toBe('open');
    expect(
      conversationPatchAfterMessage({
        author: 'user',
        body: 'Still broken.',
        createdAt: '2026-01-04T00:00:00.000Z',
      }),
    ).toEqual({
      status: 'open',
      lastMessageAt: '2026-01-04T00:00:00.000Z',
      lastMessagePreview: 'Still broken.',
      lastMessageAuthor: 'user',
    });
  });

  it('validates device token 1..4096 and platform ios|android', () => {
    expect(parseDeviceBody({ token: 'abc', platform: 'IOS' })).toEqual({
      token: 'abc',
      platform: 'ios',
    });
    expect(() => parseDeviceBody({ token: '', platform: 'ios' })).toThrow(
      SupportValidationError,
    );
    expect(() =>
      parseDeviceBody({ token: 'x'.repeat(4097), platform: 'android' }),
    ).toThrow(SupportValidationError);
    expect(() => parseDeviceBody({ token: 'abc', platform: 'web' })).toThrow(
      SupportValidationError,
    );
    expect(parseDeviceTokenBody({ token: 'tok+plus' })).toEqual({
      token: 'tok+plus',
    });
    expect(() => parseDeviceTokenBody({})).toThrow(SupportValidationError);
    expect(() => parseDeviceTokenBody({ token: '' })).toThrow(
      SupportValidationError,
    );
  });

  it('scopes device keys per uid+token hash so another user cannot be targeted', () => {
    const token = 'shared-fcm-token';
    expect(keys.devicePk(OWNER_UID)).not.toBe(keys.devicePk(OTHER_UID));
    expect(keys.deviceSk(hashDeviceToken(token))).toBe(
      `TOKEN#${hashDeviceToken(token)}`,
    );
    expect(
      isConversationOwnedBy(ownedMeta(), OTHER_UID),
    ).toBe(false);
    expect(isConversationOwnedBy(ownedMeta(), OWNER_UID)).toBe(true);
  });
});

describe('support inbox user handler (WARDROBE-286)', () => {
  const upsertDevice = jest.fn(async () => undefined);
  const deleteDevice = jest.fn(async () => undefined);
  const listConversations = jest.fn(async () => ({
    items: [ownedMeta()],
    lastEvaluatedKey: undefined as Record<string, unknown> | undefined,
  }));
  const countUnread = jest.fn(async () => 1);
  const requireConversation = jest.fn(
    async (_conversationId: string) => ownedMeta(),
  );
  const listMessages = jest.fn(async () => [
    {
      messageId: 'msg_1',
      author: 'user',
      body: 'The try-on button does nothing.',
      createdAt: '2026-01-01T00:00:00.000Z',
      screenshotKey: 'support/shot.png',
      conversationId: 'conv_1',
    },
    {
      messageId: 'msg_2',
      author: 'admin',
      body: 'Thanks for writing in.',
      createdAt: '2026-01-02T00:00:00.000Z',
      conversationId: 'conv_1',
    },
  ]);
  const markRead = jest.fn(async () => undefined);
  const persistFollowUp = jest.fn(async (input: { conversationId: string; body: string }) => ({
    conversationId: input.conversationId,
    messageId: 'msg_follow',
    messageSk: 'MSG#2026-01-04T00:00:00.000Z#msg_follow',
    body: input.body,
  }));
  const setMessageEmailStatus = jest.fn(async () => undefined);
  const presignGet = jest.fn(async () => 'https://s3.example/signed');
  const sendAlert = jest.fn(async () => undefined);
  const verifyIdToken = jest.fn(async (token: string) => {
    if (token === OWNER_TOKEN) {
      return OWNER_UID;
    }
    if (token === OTHER_TOKEN) {
      return OTHER_UID;
    }
    throw new Error('invalid token');
  });

  const deps = {
    verifyIdToken,
    upsertDevice,
    deleteDevice,
    listConversations,
    countUnread,
    requireConversation,
    listMessages,
    markRead,
    persistFollowUp,
    setMessageEmailStatus,
    presignGet,
    alert: { sendAlert },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    requireConversation.mockResolvedValue(ownedMeta());
    requireConversation.mockImplementation(async (conversationId: string) => {
      if (conversationId === 'missing') {
        throw new SupportNotFoundError();
      }
      return ownedMeta({ conversationId });
    });
    listConversations.mockResolvedValue({
      items: [ownedMeta()],
      lastEvaluatedKey: undefined,
    });
    countUnread.mockResolvedValue(1);
  });

  it.each(USER_ROUTES)(
    '$name missing token => 401 unauthorized',
    async (route) => {
      const result = asResult(
        await handleSupportInboxUser(
          event({ ...route, authorization: null }),
          deps,
        ),
      );
      expect(result.statusCode).toBe(401);
      expect(bodyOf(result)).toEqual({ error: 'unauthorized' });
      expect(verifyIdToken).not.toHaveBeenCalled();
      expect(listConversations).not.toHaveBeenCalled();
      expect(persistFollowUp).not.toHaveBeenCalled();
      expect(upsertDevice).not.toHaveBeenCalled();
      expect(deleteDevice).not.toHaveBeenCalled();
    },
  );

  it.each(USER_ROUTES)(
    '$name invalid token => 401 unauthorized',
    async (route) => {
      const result = asResult(
        await handleSupportInboxUser(
          event({ ...route, authorization: `Bearer ${INVALID_TOKEN}` }),
          deps,
        ),
      );
      expect(result.statusCode).toBe(401);
      expect(bodyOf(result)).toEqual({ error: 'unauthorized' });
    },
  );

  it('registers a device token idempotently as 204', async () => {
    const result = asResult(
      await handleSupportInboxUser(
        event({
          method: 'POST',
          path: '/support/devices',
          routeKey: 'POST /support/devices',
          body: { token: 'fcm-token', platform: 'android' },
        }),
        deps,
      ),
    );
    expect(result.statusCode).toBe(204);
    expect(result.body).toBe('');
    expect(upsertDevice).toHaveBeenCalledWith({
      uid: OWNER_UID,
      token: 'fcm-token',
      platform: 'android',
    });
  });

  it('deletes only the caller token from JSON body and returns 204 when another user owns it', async () => {
    const own = asResult(
      await handleSupportInboxUser(
        event({
          method: 'DELETE',
          path: '/support/devices',
          routeKey: 'DELETE /support/devices',
          body: { token: 'fcm-token' },
        }),
        deps,
      ),
    );
    expect(own.statusCode).toBe(204);
    expect(deleteDevice).toHaveBeenCalledWith({
      uid: OWNER_UID,
      token: 'fcm-token',
    });

    deleteDevice.mockClear();
    const other = asResult(
      await handleSupportInboxUser(
        event({
          method: 'DELETE',
          path: '/support/devices',
          routeKey: 'DELETE /support/devices',
          body: { token: 'fcm-token' },
          authorization: OTHER_TOKEN,
        }),
        deps,
      ),
    );
    expect(other.statusCode).toBe(204);
    expect(deleteDevice).toHaveBeenCalledWith({
      uid: OTHER_UID,
      token: 'fcm-token',
    });
    expect(deleteDevice).not.toHaveBeenCalledWith({
      uid: OWNER_UID,
      token: 'fcm-token',
    });
  });

  it('returns 400 validation when DELETE /support/devices is missing a token', async () => {
    const result = asResult(
      await handleSupportInboxUser(
        event({
          method: 'DELETE',
          path: '/support/devices',
          routeKey: 'DELETE /support/devices',
          body: {},
        }),
        deps,
      ),
    );
    expect(result.statusCode).toBe(400);
    expect(bodyOf(result)).toEqual(
      expect.objectContaining({ error: 'validation' }),
    );
    expect(deleteDevice).not.toHaveBeenCalled();
  });

  it('lists only the caller conversations newest first with unread and a round-tripped cursor', async () => {
    const lastEvaluatedKey = {
      PK: 'CONV#conv_1',
      SK: 'META',
      uid: OWNER_UID,
      lastMessageAt: '2026-01-02T00:00:00.000Z',
    };
    listConversations.mockResolvedValueOnce({
      items: [
        ownedMeta(),
        ownedMeta({
          conversationId: 'conv_other',
          uid: OTHER_UID,
        }),
      ],
      lastEvaluatedKey,
    });
    const result = asResult(
      await handleSupportInboxUser(
        event({
          method: 'GET',
          path: '/support/my/conversations',
          routeKey: 'GET /support/my/conversations',
          query: { limit: '10' },
        }),
        deps,
      ),
    );
    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual({
      items: [
        {
          conversationId: 'conv_1',
          status: 'replied',
          type: 'bug',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-02T00:00:00.000Z',
          lastMessagePreview: 'Thanks for writing in.',
          lastMessageAuthor: 'admin',
          unread: true,
        },
      ],
      unreadCount: 1,
      nextCursor: encodeExclusiveStartKey(lastEvaluatedKey),
    });
    expect(listConversations).toHaveBeenCalledWith({
      uid: OWNER_UID,
      limit: 10,
      exclusiveStartKey: undefined,
    });

    const cursor = encodeExclusiveStartKey(lastEvaluatedKey) as string;
    await handleSupportInboxUser(
      event({
        method: 'GET',
        path: '/support/my/conversations',
        routeKey: 'GET /support/my/conversations',
        query: { cursor },
      }),
      deps,
    );
    expect(listConversations).toHaveBeenLastCalledWith({
      uid: OWNER_UID,
      limit: 50,
      exclusiveStartKey: lastEvaluatedKey,
    });
  });

  it('returns unreadCount across every GSI page, not just the current list page', async () => {
    const pageSize = 50;
    const items = Array.from({ length: pageSize + 25 }, (_, index) => ({
      uid: OWNER_UID,
      conversationId: `conv_${index}`,
      lastMessageAuthor: index < 12 ? 'admin' : 'user',
      lastMessageAt: `2026-01-02T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`,
      lastAdminMessageAt:
        index < 12 ? '2026-01-02T00:00:00.000Z' : undefined,
    }));
    let queryCalls = 0;
    const unread = await countUnreadConversationsByUid(
      { uid: OWNER_UID, pageSize },
      async (input) => {
        queryCalls += 1;
        const start = input.exclusiveStartKey
          ? Number(input.exclusiveStartKey.start)
          : 0;
        const slice = items.slice(start, start + input.limit);
        return {
          items: slice,
          lastEvaluatedKey:
            start + input.limit < items.length
              ? { start: start + input.limit }
              : undefined,
        };
      },
    );
    expect(unread).toBe(12);
    expect(queryCalls).toBe(2);
    expect(items.length).toBeGreaterThan(pageSize);

    listConversations.mockResolvedValueOnce({
      items: [ownedMeta()],
      lastEvaluatedKey: undefined,
    });
    countUnread.mockResolvedValueOnce(12);
    const result = asResult(
      await handleSupportInboxUser(
        event({
          method: 'GET',
          path: '/support/my/conversations',
          routeKey: 'GET /support/my/conversations',
          query: { limit: '1' },
        }),
        deps,
      ),
    );
    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual(
      expect.objectContaining({
        unreadCount: 12,
        items: [expect.objectContaining({ conversationId: 'conv_1' })],
      }),
    );
    expect(
      (bodyOf(result) as { items: unknown[] }).items,
    ).toHaveLength(1);
  });

  it('returns 400 validation for a malformed cursor', async () => {
    const result = asResult(
      await handleSupportInboxUser(
        event({
          method: 'GET',
          path: '/support/my/conversations',
          routeKey: 'GET /support/my/conversations',
          query: { cursor: 'not-base64-json' },
        }),
        deps,
      ),
    );
    expect(result.statusCode).toBe(400);
    expect(bodyOf(result)).toEqual(
      expect.objectContaining({ error: 'validation' }),
    );
    expect(listConversations).not.toHaveBeenCalled();
  });

  it('returns 404 not_found when reading another user thread or a missing one', async () => {
    requireConversation.mockResolvedValueOnce(
      ownedMeta({ uid: OTHER_UID, conversationId: 'conv_other' }),
    );
    const other = asResult(
      await handleSupportInboxUser(
        event({
          method: 'GET',
          path: '/support/my/conversations/conv_other',
          routeKey: 'GET /support/my/conversations/{id}',
          pathParameters: { id: 'conv_other' },
        }),
        deps,
      ),
    );
    expect(other.statusCode).toBe(404);
    expect(bodyOf(other)).toEqual({ error: 'not_found' });
    expect(markRead).not.toHaveBeenCalled();
    expect(listMessages).not.toHaveBeenCalled();

    const missing = asResult(
      await handleSupportInboxUser(
        event({
          method: 'GET',
          path: '/support/my/conversations/missing',
          routeKey: 'GET /support/my/conversations/{id}',
          pathParameters: { id: 'missing' },
        }),
        deps,
      ),
    );
    expect(missing.statusCode).toBe(404);
    expect(bodyOf(missing)).toEqual({ error: 'not_found' });
  });

  it('returns the owned thread, oldest first, marks lastReadAt, and presigns screenshots for 900s', async () => {
    const result = asResult(
      await handleSupportInboxUser(
        event({
          method: 'GET',
          path: '/support/my/conversations/conv_1',
          routeKey: 'GET /support/my/conversations/{id}',
          pathParameters: { id: 'conv_1' },
        }),
        deps,
      ),
    );
    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual({
      conversation: {
        conversationId: 'conv_1',
        status: 'replied',
        type: 'bug',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastMessageAt: '2026-01-02T00:00:00.000Z',
      },
      messages: [
        {
          messageId: 'msg_1',
          author: 'user',
          body: 'The try-on button does nothing.',
          createdAt: '2026-01-01T00:00:00.000Z',
          screenshotUrl: 'https://s3.example/signed',
        },
        {
          messageId: 'msg_2',
          author: 'admin',
          body: 'Thanks for writing in.',
          createdAt: '2026-01-02T00:00:00.000Z',
          screenshotUrl: null,
        },
      ],
    });
    expect(markRead).toHaveBeenCalledWith({
      conversationId: 'conv_1',
      uid: OWNER_UID,
    });
    expect(presignGet).toHaveBeenCalledWith('support/shot.png');
    expect(SUPPORT_PRESIGN_EXPIRES_SECONDS).toBe(900);
  });

  it('returns 404 not_found when posting to another user thread', async () => {
    requireConversation.mockResolvedValueOnce(
      ownedMeta({ uid: OTHER_UID, conversationId: 'conv_other' }),
    );
    const result = asResult(
      await handleSupportInboxUser(
        event({
          method: 'POST',
          path: '/support/my/conversations/conv_other/messages',
          routeKey: 'POST /support/my/conversations/{id}/messages',
          pathParameters: { id: 'conv_other' },
          body: { message: 'Still broken.' },
        }),
        deps,
      ),
    );
    expect(result.statusCode).toBe(404);
    expect(bodyOf(result)).toEqual({ error: 'not_found' });
    expect(persistFollowUp).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('reopens a closed conversation, stores the follow-up, and keeps the 281 alert', async () => {
    requireConversation.mockResolvedValueOnce(
      ownedMeta({ status: 'closed' }),
    );
    const result = asResult(
      await handleSupportInboxUser(
        event({
          method: 'POST',
          path: '/support/my/conversations/conv_1/messages',
          routeKey: 'POST /support/my/conversations/{id}/messages',
          pathParameters: { id: 'conv_1' },
          body: { message: '  Still broken.  ' },
        }),
        deps,
      ),
    );
    expect(result.statusCode).toBe(201);
    expect(bodyOf(result)).toEqual({
      messageId: 'msg_follow',
      status: 'open',
    });
    expect(persistFollowUp).toHaveBeenCalledWith({
      conversationId: 'conv_1',
      uid: OWNER_UID,
      body: 'Still broken.',
    });
    expect(sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv_1',
        type: 'bug',
        message: 'Still broken.',
        email: 'user@example.com',
        platform: 'ios',
        uid: OWNER_UID,
      }),
    );
    expect(setMessageEmailStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv_1',
        emailStatus: 'sent',
      }),
    );
  });
});
