import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

jest.mock('../../src/functions/support-inbox/table', () => {
  const actual = jest.requireActual(
    '../../src/functions/support-inbox/table',
  ) as typeof import('../../src/functions/support-inbox/table');
  return {
    ...actual,
    transactPutAdminReply: jest.fn().mockResolvedValue(undefined),
  };
});

import { handleSupportInboxAdmin } from '../../src/functions/support-inbox/admin-handler';
import { parseAdminListQuery } from '../../src/functions/support-inbox/admin-validation';
import {
  resetSupportInboxAlertCache,
  safeReplyFailureFields,
} from '../../src/functions/support-inbox/alert';
import {
  decodeExclusiveStartKey,
  encodeExclusiveStartKey,
} from '../../src/functions/support-inbox/cursor';
import {
  SupportNotFoundError,
  SupportNotRetryableError,
  SupportValidationError,
} from '../../src/functions/support-inbox/http';
import {
  adminReplyMessageItem,
  isLatestAdminMessage,
  isRetryableAdminEmail,
  persistAdminReply,
} from '../../src/functions/support-inbox/model';
import {
  escapeHtml,
  formatSupportInboxReply,
  loadSupportInboxAppLink,
  sendSupportInboxReplyBestEffort,
  supportConversationAppUrl,
} from '../../src/functions/support-inbox/reply';
import { transactPutAdminReply } from '../../src/functions/support-inbox/table';
import {
  conversationPatchAfterMessage,
  statusAfterUserFollowUp,
} from '../../src/functions/support-inbox/status';
import { parseReplyBody } from '../../src/functions/support-inbox/validation';
import { logger } from '../../src/shared/logger';
import {
  SUPPORT_EMAIL_RETRY_CLAIM_STALE_MS,
  SUPPORT_EMAIL_TIMEOUT_MS,
  SUPPORT_PRESIGN_EXPIRES_SECONDS,
} from '../../src/shared/support-inbox-names';

const SECRET_LIKE_KEY = 're_test_placeholder_key';
const ADMIN_TOKEN = 'admin-token';
const USER_TOKEN = 'user-token';
const INVALID_TOKEN = 'not.a.jwt';
const transactPutAdminReplyMock = transactPutAdminReply as jest.MockedFunction<
  typeof transactPutAdminReply
>;

function assertSafeReplyFailureLog(fields: unknown): void {
  expect(fields).toEqual(
    expect.objectContaining({
      conversationId: expect.any(String),
      messageId: expect.any(String),
      error: expect.any(String),
    }),
  );
  const record = fields as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    expect(['conversationId', 'messageId', 'error', 'code']).toContain(key);
  }
  const blob = JSON.stringify(record);
  expect(blob).not.toContain('user@example.com');
  expect(blob).not.toContain('Thanks for writing in.');
  expect(blob).not.toContain(SECRET_LIKE_KEY);
  expect(blob).not.toMatch(/re_[A-Za-z0-9]/);
  expect(blob.toLowerCase()).not.toContain('apikey');
}

function asResult(
  result: Awaited<ReturnType<typeof handleSupportInboxAdmin>>,
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
    headers.authorization = `Bearer ${ADMIN_TOKEN}`;
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

const ADMIN_ROUTES: Array<{
  name: string;
  method: string;
  path: string;
  routeKey: string;
  pathParameters?: Record<string, string>;
  body?: unknown;
}> = [
  {
    name: 'list',
    method: 'GET',
    path: '/admin/support/conversations',
    routeKey: 'GET /admin/support/conversations',
  },
  {
    name: 'thread',
    method: 'GET',
    path: '/admin/support/conversations/conv_1',
    routeKey: 'GET /admin/support/conversations/{conversationId}',
    pathParameters: { conversationId: 'conv_1' },
  },
  {
    name: 'reply',
    method: 'POST',
    path: '/admin/support/conversations/conv_1/replies',
    routeKey: 'POST /admin/support/conversations/{conversationId}/replies',
    pathParameters: { conversationId: 'conv_1' },
    body: { message: 'Thanks for writing in.' },
  },
  {
    name: 'close',
    method: 'POST',
    path: '/admin/support/conversations/conv_1/close',
    routeKey: 'POST /admin/support/conversations/{conversationId}/close',
    pathParameters: { conversationId: 'conv_1' },
  },
  {
    name: 'retry',
    method: 'POST',
    path: '/admin/support/conversations/conv_1/messages/msg_1/retry-email',
    routeKey:
      'POST /admin/support/conversations/{conversationId}/messages/{messageId}/retry-email',
    pathParameters: { conversationId: 'conv_1', messageId: 'msg_1' },
  },
];

describe('support inbox admin helpers (WARDROBE-284)', () => {
  it('defaults list status to open and validates limit', () => {
    expect(parseAdminListQuery(undefined)).toEqual({
      status: 'open',
      limit: 50,
    });
    expect(parseAdminListQuery({ status: 'replied', limit: '2' })).toEqual({
      status: 'replied',
      limit: 2,
    });
    expect(() => parseAdminListQuery({ limit: '0' })).toThrow(
      SupportValidationError,
    );
    expect(() => parseAdminListQuery({ limit: '101' })).toThrow(
      SupportValidationError,
    );
    expect(() => parseAdminListQuery({ status: 'nope' })).toThrow(
      SupportValidationError,
    );
  });

  it('round-trips an opaque LastEvaluatedKey cursor', () => {
    const key = {
      PK: 'CONV#conv_1',
      SK: 'META',
      status: 'open',
      lastMessageAt: '2026-01-01T00:00:00.000Z',
    };
    const cursor = encodeExclusiveStartKey(key);
    expect(cursor).toEqual(expect.any(String));
    expect(decodeExclusiveStartKey(cursor as string)).toEqual(key);
    expect(() => parseAdminListQuery({ cursor: 'not-base64-json' })).toThrow(
      SupportValidationError,
    );
  });

  it.each([
    ['bad base64', '%%%'],
    ['bad JSON', Buffer.from('not-json', 'utf8').toString('base64')],
    [
      'wrong key shape',
      Buffer.from(JSON.stringify({ foo: 1 }), 'utf8').toString('base64'),
    ],
    [
      'uid index key',
      Buffer.from(
        JSON.stringify({
          PK: 'CONV#conv_1',
          SK: 'META',
          uid: 'firebase-uid-owner',
          lastMessageAt: '2026-01-01T00:00:00.000Z',
        }),
        'utf8',
      ).toString('base64'),
    ],
  ])('rejects a %s list cursor', (_name, cursor) => {
    expect(() => parseAdminListQuery({ cursor })).toThrow(SupportValidationError);
    try {
      parseAdminListQuery({ cursor });
    } catch (error) {
      expect(error).toBeInstanceOf(SupportValidationError);
      expect((error as SupportValidationError).fields).toEqual({
        cursor: expect.any(String),
      });
    }
  });

  it('sets replied for admin messages and open for user follow-up (WARDROBE-286 hook)', () => {
    expect(
      conversationPatchAfterMessage({
        author: 'admin',
        body: 'x'.repeat(200),
        createdAt: '2026-01-02T00:00:00.000Z',
      }),
    ).toEqual({
      status: 'replied',
      lastMessageAt: '2026-01-02T00:00:00.000Z',
      lastMessagePreview: 'x'.repeat(140),
      lastMessageAuthor: 'admin',
      lastAdminMessageAt: '2026-01-02T00:00:00.000Z',
    });
    expect(statusAfterUserFollowUp()).toBe('open');
    expect(
      conversationPatchAfterMessage({
        author: 'user',
        body: 'follow up',
        createdAt: '2026-01-03T00:00:00.000Z',
      }).status,
    ).toBe('open');
  });

  it('treats failed and stale sending admin messages as retryable', () => {
    expect(SUPPORT_EMAIL_RETRY_CLAIM_STALE_MS).toBe(2 * SUPPORT_EMAIL_TIMEOUT_MS);
    expect(
      isRetryableAdminEmail({ author: 'admin', emailStatus: 'failed' }),
    ).toBe(true);
    expect(
      isRetryableAdminEmail({
        author: 'admin',
        emailStatus: 'sending',
        updatedAt: new Date(
          Date.now() - SUPPORT_EMAIL_RETRY_CLAIM_STALE_MS - 1,
        ).toISOString(),
      }),
    ).toBe(true);
    expect(
      isRetryableAdminEmail({
        author: 'admin',
        emailStatus: 'sending',
        updatedAt: new Date().toISOString(),
      }),
    ).toBe(false);
    expect(
      isRetryableAdminEmail({ author: 'admin', emailStatus: 'sent' }),
    ).toBe(false);
    expect(
      isRetryableAdminEmail({ author: 'user', emailStatus: 'failed' }),
    ).toBe(false);
  });

  it('identifies the latest admin message from META messageId or createdAt', () => {
    const latest = {
      messageId: 'msg_latest',
      createdAt: '2026-01-03T00:00:00.000Z',
      author: 'admin',
    };
    const older = {
      messageId: 'msg_old',
      createdAt: '2026-01-01T00:00:00.000Z',
      author: 'admin',
    };
    expect(
      isLatestAdminMessage(
        {
          lastMessageAuthor: 'admin',
          lastAdminMessageId: 'msg_latest',
          lastMessageAt: '2026-01-03T00:00:00.000Z',
        },
        latest,
      ),
    ).toBe(true);
    expect(
      isLatestAdminMessage(
        {
          lastMessageAuthor: 'admin',
          lastAdminMessageId: 'msg_latest',
          lastMessageAt: '2026-01-03T00:00:00.000Z',
        },
        older,
      ),
    ).toBe(false);
    expect(
      isLatestAdminMessage(
        {
          lastMessageAuthor: 'admin',
          lastMessageAt: '2026-01-03T00:00:00.000Z',
        },
        latest,
      ),
    ).toBe(true);
    expect(
      isLatestAdminMessage(
        {
          lastMessageAuthor: 'user',
          lastMessageAt: '2026-01-04T00:00:00.000Z',
        },
        latest,
      ),
    ).toBe(false);
  });

  it('validates reply message 1..5000 trimmed', () => {
    expect(parseReplyBody({ message: '  hello  ' })).toEqual({
      message: 'hello',
    });
    expect(() => parseReplyBody({ message: '' })).toThrow(SupportValidationError);
    expect(() => parseReplyBody({ message: 'x'.repeat(5001) })).toThrow(
      SupportValidationError,
    );
  });

  it('escapes reply HTML and omits the app link when missing', () => {
    const withLink = formatSupportInboxReply(
      'See <script>alert(1)</script>',
      'https://example.invalid/app',
    );
    expect(withLink.html).toContain('&lt;script&gt;');
    expect(withLink.html).not.toContain('<script>');
    expect(withLink.html).toContain('Open in Pocket Closet');
    expect(withLink.text).toContain('https://example.invalid/app');

    const withoutLink = formatSupportInboxReply('Thanks for writing in.');
    expect(withoutLink.html).not.toContain('Open in Pocket Closet');
    expect(withoutLink.text).toBe('Thanks for writing in.');
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('builds Open in Pocket Closet as <app-link>/support/{conversationId} and trims a trailing slash', () => {
    expect(
      supportConversationAppUrl('https://example.invalid/app', 'conv_1'),
    ).toBe('https://example.invalid/app/support/conv_1');
    expect(
      supportConversationAppUrl('https://example.invalid/app/', 'conv_1'),
    ).toBe('https://example.invalid/app/support/conv_1');
    expect(
      supportConversationAppUrl('https://example.invalid/app///', 'conv_1'),
    ).toBe('https://example.invalid/app/support/conv_1');
    expect(supportConversationAppUrl(undefined, 'conv_1')).toBeUndefined();
    expect(supportConversationAppUrl('  ', 'conv_1')).toBeUndefined();
  });
});

describe('support inbox admin handler (WARDROBE-284)', () => {
  const listConversations = jest.fn(
    async (): Promise<{
      items: Array<Record<string, unknown>>;
      lastEvaluatedKey?: Record<string, unknown>;
    }> => ({
      items: [
        {
          conversationId: 'conv_1',
          status: 'open',
          type: 'bug',
          email: 'user@example.com',
          platform: 'ios',
          uid: 'firebase-uid-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-02T00:00:00.000Z',
          lastMessagePreview: 'The try-on button does nothing.',
          lastMessageAuthor: 'user',
          lastEmailStatus: 'sent',
        },
      ],
      lastEvaluatedKey: undefined,
    }),
  );
  const requireConversation = jest.fn(async (): Promise<Record<string, unknown>> => ({
    conversationId: 'conv_1',
    status: 'open',
    type: 'bug',
    email: 'user@example.com',
    platform: 'ios',
    uid: 'firebase-uid-1',
    appVersion: '1.2.3',
    device: 'iPhone',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastMessageAt: '2026-01-01T00:00:00.000Z',
    lastMessageAuthor: 'user',
    screenshotKey: 'support/shot.png',
  }));
  const listMessages = jest.fn(async () => [
    {
      SK: 'MSG#2026-01-01T00:00:00.000Z#msg_1',
      messageId: 'msg_1',
      author: 'user',
      body: 'The try-on button does nothing.',
      createdAt: '2026-01-01T00:00:00.000Z',
      screenshotKey: 'support/shot.png',
      emailStatus: 'sent',
      conversationId: 'conv_1',
    },
    {
      SK: 'MSG#2026-01-02T00:00:00.000Z#msg_2',
      messageId: 'msg_2',
      author: 'admin',
      body: 'Thanks for writing in.',
      createdAt: '2026-01-02T00:00:00.000Z',
      emailStatus: 'failed',
      conversationId: 'conv_1',
    },
  ]);
  const persistReply = jest.fn(async (input: { conversationId: string; body: string }) => ({
    conversationId: input.conversationId,
    messageId: 'msg_admin',
    messageSk: 'MSG#2026-01-03T00:00:00.000Z#msg_admin',
    body: input.body,
  }));
  const persistClose = jest.fn(async (conversationId: string) => ({
    conversationId,
    status: 'closed' as const,
  }));
  const requireMessage = jest.fn(async (): Promise<Record<string, unknown>> => ({
    SK: 'MSG#2026-01-02T00:00:00.000Z#msg_1',
    messageId: 'msg_1',
    author: 'admin',
    body: 'Thanks for writing in.',
    emailStatus: 'failed',
    createdAt: '2026-01-02T00:00:00.000Z',
  }));
  const claimRetry = jest.fn(async () => undefined);
  const setMessageEmailStatus = jest.fn(async () => undefined);
  const setMessagePushStatus = jest.fn(async () => undefined);
  const sendPush = jest.fn(
    async (): Promise<'sent' | 'failed' | 'skipped'> => 'skipped',
  );
  const presignGet = jest.fn(async () => 'https://s3.example/signed');
  const sendReply = jest.fn(async () => undefined);
  const verifyIdToken = jest.fn(async (token: string) => {
    if (token === ADMIN_TOKEN) {
      return { uid: 'admin-1', admin: true };
    }
    if (token === USER_TOKEN) {
      return { uid: 'user-1', admin: false };
    }
    throw new Error('invalid token');
  });

  const deps = {
    verifyIdToken,
    listConversations,
    requireConversation,
    listMessages,
    persistReply,
    persistClose,
    requireMessage,
    claimRetry,
    setMessageEmailStatus,
    setMessagePushStatus,
    sendPush,
    presignGet,
    reply: { sendReply },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    listConversations.mockResolvedValue({
      items: [
        {
          conversationId: 'conv_1',
          status: 'open',
          type: 'bug',
          email: 'user@example.com',
          platform: 'ios',
          uid: 'firebase-uid-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-01-02T00:00:00.000Z',
          lastMessagePreview: 'The try-on button does nothing.',
          lastMessageAuthor: 'user',
          lastEmailStatus: 'sent',
        },
      ],
      lastEvaluatedKey: undefined,
    });
    requireMessage.mockResolvedValue({
      SK: 'MSG#2026-01-02T00:00:00.000Z#msg_1',
      messageId: 'msg_1',
      author: 'admin',
      body: 'Thanks for writing in.',
      emailStatus: 'failed',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    claimRetry.mockResolvedValue(undefined);
  });

  it('covers every admin route for missing, invalid, and non-admin tokens', () => {
    expect(ADMIN_ROUTES.map((route) => route.routeKey)).toEqual([
      'GET /admin/support/conversations',
      'GET /admin/support/conversations/{conversationId}',
      'POST /admin/support/conversations/{conversationId}/replies',
      'POST /admin/support/conversations/{conversationId}/close',
      'POST /admin/support/conversations/{conversationId}/messages/{messageId}/retry-email',
    ]);
  });

  it.each(ADMIN_ROUTES)(
    '$name missing token => 401 unauthorized',
    async (route) => {
      const result = asResult(
        await handleSupportInboxAdmin(
          event({
            ...route,
            authorization: null,
          }),
          deps,
        ),
      );
      expect(result.statusCode).toBe(401);
      expect(bodyOf(result)).toEqual({ error: 'unauthorized' });
      expect(verifyIdToken).not.toHaveBeenCalled();
      expect(listConversations).not.toHaveBeenCalled();
      expect(persistReply).not.toHaveBeenCalled();
      expect(persistClose).not.toHaveBeenCalled();
      expect(sendReply).not.toHaveBeenCalled();
    },
  );

  it.each(ADMIN_ROUTES)(
    '$name invalid token => 401 unauthorized',
    async (route) => {
      const result = asResult(
        await handleSupportInboxAdmin(
          event({
            ...route,
            authorization: `Bearer ${INVALID_TOKEN}`,
          }),
          deps,
        ),
      );
      expect(result.statusCode).toBe(401);
      expect(bodyOf(result)).toEqual({ error: 'unauthorized' });
      expect(verifyIdToken).toHaveBeenCalledWith(INVALID_TOKEN);
      expect(listConversations).not.toHaveBeenCalled();
      expect(persistReply).not.toHaveBeenCalled();
      expect(persistClose).not.toHaveBeenCalled();
      expect(sendReply).not.toHaveBeenCalled();
    },
  );

  it.each(ADMIN_ROUTES)(
    '$name non-admin token => 403 forbidden',
    async (route) => {
      const result = asResult(
        await handleSupportInboxAdmin(
          event({
            ...route,
            authorization: USER_TOKEN,
          }),
          deps,
        ),
      );
      expect(result.statusCode).toBe(403);
      expect(bodyOf(result)).toEqual({ error: 'forbidden' });
      expect(verifyIdToken).toHaveBeenCalledWith(USER_TOKEN);
      expect(listConversations).not.toHaveBeenCalled();
      expect(persistReply).not.toHaveBeenCalled();
      expect(persistClose).not.toHaveBeenCalled();
      expect(sendReply).not.toHaveBeenCalled();
    },
  );

  it.each(ADMIN_ROUTES)('$name admin token => success', async (route) => {
    const result = asResult(
      await handleSupportInboxAdmin(
        event({
          ...route,
          authorization: ADMIN_TOKEN,
        }),
        deps,
      ),
    );
    expect(result.statusCode).toBeGreaterThanOrEqual(200);
    expect(result.statusCode).toBeLessThan(300);
    expect(verifyIdToken).toHaveBeenCalledWith(ADMIN_TOKEN);
  });

  it('lists by status, defaults to open, and validates limit', async () => {
    const listed = asResult(
      await handleSupportInboxAdmin(
        event({
          method: 'GET',
          path: '/admin/support/conversations',
          routeKey: 'GET /admin/support/conversations',
          query: { status: 'closed', limit: '10' },
        }),
        deps,
      ),
    );
    expect(listed.statusCode).toBe(200);
    expect(listConversations).toHaveBeenCalledWith({
      status: 'closed',
      limit: 10,
      exclusiveStartKey: undefined,
    });
    expect(bodyOf(listed)).toEqual({
      items: [
        expect.objectContaining({
          conversationId: 'conv_1',
          uid: 'firebase-uid-1',
          lastMessagePreview: 'The try-on button does nothing.',
          lastMessageAuthor: 'user',
          lastEmailStatus: 'sent',
        }),
      ],
      nextCursor: null,
    });

    listConversations.mockClear();
    await handleSupportInboxAdmin(
      event({
        method: 'GET',
        path: '/admin/support/conversations',
        routeKey: 'GET /admin/support/conversations',
      }),
      deps,
    );
    expect(listConversations).toHaveBeenCalledWith({
      status: 'open',
      limit: 50,
      exclusiveStartKey: undefined,
    });

    const invalid = asResult(
      await handleSupportInboxAdmin(
        event({
          method: 'GET',
          path: '/admin/support/conversations',
          routeKey: 'GET /admin/support/conversations',
          query: { limit: '999' },
        }),
        deps,
      ),
    );
    expect(invalid.statusCode).toBe(400);
    expect(bodyOf(invalid)).toEqual({
      error: 'validation',
      fields: expect.objectContaining({ limit: expect.any(String) }),
    });
  });

  it('round-trips a cursor across two pages', async () => {
    const lastEvaluatedKey = {
      PK: 'CONV#conv_1',
      SK: 'META',
      status: 'open',
      lastMessageAt: '2026-01-01T00:00:00.000Z',
    };
    listConversations.mockResolvedValueOnce({
      items: [{ conversationId: 'conv_1', status: 'open' }],
      lastEvaluatedKey,
    });

    const first = asResult(
      await handleSupportInboxAdmin(
        event({
          method: 'GET',
          path: '/admin/support/conversations',
          routeKey: 'GET /admin/support/conversations',
          query: { limit: '1' },
        }),
        deps,
      ),
    );
    const firstBody = bodyOf(first) as {
      items: Array<{ conversationId: string }>;
      nextCursor: string | null;
    };
    expect(first.statusCode).toBe(200);
    expect(firstBody.items.map((item) => item.conversationId)).toEqual(['conv_1']);
    expect(firstBody.nextCursor).toBe(encodeExclusiveStartKey(lastEvaluatedKey));
    expect(decodeExclusiveStartKey(firstBody.nextCursor as string)).toEqual(
      lastEvaluatedKey,
    );

    listConversations.mockResolvedValueOnce({
      items: [{ conversationId: 'conv_2', status: 'open' }],
      lastEvaluatedKey: undefined,
    });
    const second = asResult(
      await handleSupportInboxAdmin(
        event({
          method: 'GET',
          path: '/admin/support/conversations',
          routeKey: 'GET /admin/support/conversations',
          query: { limit: '1', cursor: firstBody.nextCursor as string },
        }),
        deps,
      ),
    );
    const secondBody = bodyOf(second) as {
      items: Array<{ conversationId: string }>;
      nextCursor: string | null;
    };
    expect(second.statusCode).toBe(200);
    expect(listConversations).toHaveBeenLastCalledWith({
      status: 'open',
      limit: 1,
      exclusiveStartKey: lastEvaluatedKey,
    });
    expect(secondBody.items.map((item) => item.conversationId)).toEqual([
      'conv_2',
    ]);
    expect(secondBody.items.map((item) => item.conversationId)).not.toContain(
      'conv_1',
    );
    expect(secondBody.nextCursor).toBeNull();
  });

  it.each([
    ['bad base64', '%%%'],
    ['bad JSON', Buffer.from('not-json', 'utf8').toString('base64')],
    [
      'wrong key shape',
      Buffer.from(JSON.stringify({ foo: 1 }), 'utf8').toString('base64'),
    ],
  ])(
    'GET /admin/support/conversations malformed cursor (%s) returns 400 validation',
    async (_name, cursor) => {
      const result = asResult(
        await handleSupportInboxAdmin(
          event({
            method: 'GET',
            path: '/admin/support/conversations',
            routeKey: 'GET /admin/support/conversations',
            query: { cursor },
          }),
          deps,
        ),
      );
      expect(result.statusCode).toBe(400);
      expect(bodyOf(result)).toEqual({
        error: 'validation',
        fields: { cursor: expect.any(String) },
      });
      expect(listConversations).not.toHaveBeenCalled();
    },
  );

  it('returns thread messages oldest first with a 900s presigned screenshot URL', async () => {
    const result = asResult(
      await handleSupportInboxAdmin(
        event({
          method: 'GET',
          path: '/admin/support/conversations/conv_1',
          routeKey: 'GET /admin/support/conversations/{conversationId}',
          pathParameters: { conversationId: 'conv_1' },
        }),
        deps,
      ),
    );
    expect(result.statusCode).toBe(200);
    const body = bodyOf(result) as {
      conversation: { conversationId: string; uid: string | null };
      messages: Array<{ messageId: string; screenshotUrl: string | null }>;
    };
    expect(body.conversation).toEqual(
      expect.objectContaining({
        conversationId: 'conv_1',
        uid: 'firebase-uid-1',
        appVersion: '1.2.3',
        device: 'iPhone',
      }),
    );
    expect(body.messages.map((message) => message.messageId)).toEqual([
      'msg_1',
      'msg_2',
    ]);
    expect(body.messages[0]?.screenshotUrl).toBe('https://s3.example/signed');
    expect(body.messages[1]?.screenshotUrl).toBeNull();
    expect(presignGet).toHaveBeenCalledWith('support/shot.png');
    expect(SUPPORT_PRESIGN_EXPIRES_SECONDS).toBe(900);
  });

  it('returns 404 for an unknown conversation thread', async () => {
    requireConversation.mockRejectedValueOnce(new SupportNotFoundError());
    const result = asResult(
      await handleSupportInboxAdmin(
        event({
          method: 'GET',
          path: '/admin/support/conversations/missing',
          routeKey: 'GET /admin/support/conversations/{conversationId}',
          pathParameters: { conversationId: 'missing' },
        }),
        deps,
      ),
    );
    expect(result.statusCode).toBe(404);
    expect(bodyOf(result)).toEqual({ error: 'not_found' });
  });

  it('rejects invalid reply bodies and stores before sending', async () => {
    const invalid = asResult(
      await handleSupportInboxAdmin(
        event({
          method: 'POST',
          path: '/admin/support/conversations/conv_1/replies',
          routeKey: 'POST /admin/support/conversations/{conversationId}/replies',
          pathParameters: { conversationId: 'conv_1' },
          body: { message: '   ' },
        }),
        deps,
      ),
    );
    expect(invalid.statusCode).toBe(400);
    expect(bodyOf(invalid)).toEqual({
      error: 'validation',
      fields: expect.objectContaining({ message: expect.any(String) }),
    });
    expect(persistReply).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it('replies with status transition to replied and Resend success => sent', async () => {
    const result = asResult(
      await handleSupportInboxAdmin(
        event({
          method: 'POST',
          path: '/admin/support/conversations/conv_1/replies',
          routeKey: 'POST /admin/support/conversations/{conversationId}/replies',
          pathParameters: { conversationId: 'conv_1' },
          body: { message: '  Thanks for writing in.  ' },
        }),
        deps,
      ),
    );
    expect(result.statusCode).toBe(201);
    expect(bodyOf(result)).toEqual({
      messageId: 'msg_admin',
      emailStatus: 'sent',
    });
    expect(persistReply).toHaveBeenCalledWith({
      conversationId: 'conv_1',
      body: 'Thanks for writing in.',
    });
    expect(adminReplyMessageItem({
      conversationId: 'conv_1',
      body: 'Thanks for writing in.',
      messageId: 'msg_admin',
      createdAt: '2026-01-03T00:00:00.000Z',
    }).author).toBe('admin');
    expect(
      conversationPatchAfterMessage({
        author: 'admin',
        body: 'Thanks for writing in.',
        createdAt: '2026-01-03T00:00:00.000Z',
      }).status,
    ).toBe('replied');
    expect(sendReply).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv_1',
        messageId: 'msg_admin',
        email: 'user@example.com',
      }),
    );
    expect(setMessageEmailStatus).toHaveBeenCalledWith({
      conversationId: 'conv_1',
      messageSk: 'MSG#2026-01-03T00:00:00.000Z#msg_admin',
      emailStatus: 'sent',
    });
    expect(sendPush).toHaveBeenCalledWith(
      {
        conversationId: 'conv_1',
        messageId: 'msg_admin',
        uid: 'firebase-uid-1',
      },
      undefined,
    );
    expect(setMessagePushStatus).toHaveBeenCalledWith({
      conversationId: 'conv_1',
      messageSk: 'MSG#2026-01-03T00:00:00.000Z#msg_admin',
      pushStatus: 'skipped',
    });
  });

  it('returns 201, sets status replied, and records emailStatus failed when Resend throws', async () => {
    transactPutAdminReplyMock.mockClear();
    sendReply.mockRejectedValueOnce(new Error('Resend down'));
    const result = asResult(
      await handleSupportInboxAdmin(
        event({
          method: 'POST',
          path: '/admin/support/conversations/conv_1/replies',
          routeKey: 'POST /admin/support/conversations/{conversationId}/replies',
          pathParameters: { conversationId: 'conv_1' },
          body: { message: 'Thanks for writing in.' },
        }),
        {
          ...deps,
          persistReply: persistAdminReply,
        },
      ),
    );
    expect(result.statusCode).toBe(201);
    expect(bodyOf(result)).toEqual({
      messageId: expect.stringMatching(/^msg_/),
      emailStatus: 'failed',
    });
    expect(transactPutAdminReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv_1',
        status: 'replied',
        lastMessageAuthor: 'admin',
        lastMessagePreview: 'Thanks for writing in.',
      }),
    );
    expect(sendReply).toHaveBeenCalled();
    expect(setMessageEmailStatus).toHaveBeenCalledWith(
      expect.objectContaining({ emailStatus: 'failed' }),
    );
    expect(result.statusCode).toBe(201);
  });

  it('sends FCM after the reply write, stores pushStatus, and keeps 201 when push throws', async () => {
    sendPush.mockResolvedValueOnce('sent');
    const sent = asResult(
      await handleSupportInboxAdmin(
        event({
          method: 'POST',
          path: '/admin/support/conversations/conv_1/replies',
          routeKey: 'POST /admin/support/conversations/{conversationId}/replies',
          pathParameters: { conversationId: 'conv_1' },
          body: { message: 'Thanks for writing in.' },
        }),
        deps,
      ),
    );
    expect(sent.statusCode).toBe(201);
    expect(bodyOf(sent)).toEqual({
      messageId: 'msg_admin',
      emailStatus: 'sent',
    });
    expect(sendPush).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv_1',
        messageId: 'msg_admin',
        uid: 'firebase-uid-1',
      }),
      undefined,
    );
    expect(setMessagePushStatus).toHaveBeenCalledWith(
      expect.objectContaining({ pushStatus: 'sent' }),
    );

    sendPush.mockRejectedValueOnce(new Error('FCM exploded'));
    const thrown = asResult(
      await handleSupportInboxAdmin(
        event({
          method: 'POST',
          path: '/admin/support/conversations/conv_1/replies',
          routeKey: 'POST /admin/support/conversations/{conversationId}/replies',
          pathParameters: { conversationId: 'conv_1' },
          body: { message: 'Thanks for writing in.' },
        }),
        deps,
      ),
    );
    expect(thrown.statusCode).toBe(201);
    expect(bodyOf(thrown)).toEqual({
      messageId: 'msg_admin',
      emailStatus: 'sent',
    });
    expect(setMessagePushStatus).toHaveBeenCalledWith(
      expect.objectContaining({ pushStatus: 'failed' }),
    );
  });

  it('writes MSG before calling Resend', async () => {
    const order: string[] = [];
    persistReply.mockImplementation(async (input: { conversationId: string; body: string }) => {
      order.push('put');
      return {
        conversationId: input.conversationId,
        messageId: 'msg_admin',
        messageSk: 'MSG#2026-01-03T00:00:00.000Z#msg_admin',
        body: input.body,
      };
    });
    sendReply.mockImplementation(async () => {
      order.push('send');
    });
    setMessageEmailStatus.mockImplementation(async () => {
      order.push('status');
    });

    await handleSupportInboxAdmin(
      event({
        method: 'POST',
        path: '/admin/support/conversations/conv_1/replies',
        routeKey: 'POST /admin/support/conversations/{conversationId}/replies',
        pathParameters: { conversationId: 'conv_1' },
        body: { message: 'Thanks for writing in.' },
      }),
      deps,
    );

    expect(order).toEqual(['put', 'send', 'status']);
  });

  it('close called twice returns 200 both times', async () => {
    const first = asResult(
      await handleSupportInboxAdmin(
        event({
          method: 'POST',
          path: '/admin/support/conversations/conv_1/close',
          routeKey: 'POST /admin/support/conversations/{conversationId}/close',
          pathParameters: { conversationId: 'conv_1' },
        }),
        deps,
      ),
    );
    const second = asResult(
      await handleSupportInboxAdmin(
        event({
          method: 'POST',
          path: '/admin/support/conversations/conv_1/close',
          routeKey: 'POST /admin/support/conversations/{conversationId}/close',
          pathParameters: { conversationId: 'conv_1' },
        }),
        deps,
      ),
    );
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(bodyOf(first)).toEqual({ conversationId: 'conv_1', status: 'closed' });
    expect(bodyOf(second)).toEqual({ conversationId: 'conv_1', status: 'closed' });
    expect(persistClose).toHaveBeenCalledTimes(2);
  });

  const retryEmailEvent = () =>
    event({
      method: 'POST',
      path: '/admin/support/conversations/conv_1/messages/msg_1/retry-email',
      routeKey:
        'POST /admin/support/conversations/{conversationId}/messages/{messageId}/retry-email',
      pathParameters: { conversationId: 'conv_1', messageId: 'msg_1' },
    });

  it('retries a failed admin email', async () => {
    const retried = asResult(
      await handleSupportInboxAdmin(retryEmailEvent(), deps),
    );
    expect(retried.statusCode).toBe(200);
    expect(bodyOf(retried)).toEqual({
      messageId: 'msg_1',
      emailStatus: 'sent',
    });
    expect(claimRetry).toHaveBeenCalledWith({
      conversationId: 'conv_1',
      messageSk: 'MSG#2026-01-02T00:00:00.000Z#msg_1',
    });
    expect(sendReply).toHaveBeenCalled();
  });

  it('retries a stale sending claim and sends once', async () => {
    requireMessage.mockResolvedValue({
      SK: 'MSG#2026-01-02T00:00:00.000Z#msg_1',
      messageId: 'msg_1',
      author: 'admin',
      body: 'Thanks for writing in.',
      emailStatus: 'sending',
      updatedAt: new Date(
        Date.now() - SUPPORT_EMAIL_RETRY_CLAIM_STALE_MS - 1,
      ).toISOString(),
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    const retried = asResult(
      await handleSupportInboxAdmin(retryEmailEvent(), deps),
    );
    expect(retried.statusCode).toBe(200);
    expect(bodyOf(retried)).toEqual({
      messageId: 'msg_1',
      emailStatus: 'sent',
    });
    expect(claimRetry).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledTimes(1);
  });

  it('returns 409 for a fresh sending claim', async () => {
    requireMessage.mockResolvedValue({
      SK: 'MSG#2026-01-02T00:00:00.000Z#msg_1',
      messageId: 'msg_1',
      author: 'admin',
      body: 'Thanks for writing in.',
      emailStatus: 'sending',
      updatedAt: new Date().toISOString(),
    });

    const result = asResult(
      await handleSupportInboxAdmin(retryEmailEvent(), deps),
    );
    expect(result.statusCode).toBe(409);
    expect(bodyOf(result)).toEqual({ error: 'not_retryable' });
    expect(claimRetry).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it('retries a stale sending claim concurrently: exactly one send and the other 409', async () => {
    requireMessage.mockResolvedValue({
      SK: 'MSG#2026-01-02T00:00:00.000Z#msg_1',
      messageId: 'msg_1',
      author: 'admin',
      body: 'Thanks for writing in.',
      emailStatus: 'sending',
      updatedAt: new Date(
        Date.now() - SUPPORT_EMAIL_RETRY_CLAIM_STALE_MS - 1,
      ).toISOString(),
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    let claimed = false;
    claimRetry.mockImplementation(async () => {
      if (claimed) {
        throw new SupportNotRetryableError();
      }
      claimed = true;
    });

    const [first, second] = await Promise.all([
      handleSupportInboxAdmin(retryEmailEvent(), deps),
      handleSupportInboxAdmin(retryEmailEvent(), deps),
    ]);
    const results = [asResult(first), asResult(second)];
    const statuses = results.map((result) => result.statusCode).sort();
    expect(statuses).toEqual([200, 409]);
    const bodies = results.map((result) => bodyOf(result));
    expect(bodies).toEqual(
      expect.arrayContaining([
        { messageId: 'msg_1', emailStatus: 'sent' },
        { error: 'not_retryable' },
      ]),
    );
    expect(claimRetry).toHaveBeenCalledTimes(2);
    expect(sendReply).toHaveBeenCalledTimes(1);
  });

  it('retries concurrently: exactly one send and the other 409', async () => {
    let claimed = false;
    claimRetry.mockImplementation(async () => {
      if (claimed) {
        throw new SupportNotRetryableError();
      }
      claimed = true;
    });

    const [first, second] = await Promise.all([
      handleSupportInboxAdmin(retryEmailEvent(), deps),
      handleSupportInboxAdmin(retryEmailEvent(), deps),
    ]);
    const results = [asResult(first), asResult(second)];
    const statuses = results.map((result) => result.statusCode).sort();
    expect(statuses).toEqual([200, 409]);
    const bodies = results.map((result) => bodyOf(result));
    expect(bodies).toEqual(
      expect.arrayContaining([
        { messageId: 'msg_1', emailStatus: 'sent' },
        { error: 'not_retryable' },
      ]),
    );
    expect(claimRetry).toHaveBeenCalledTimes(2);
    expect(sendReply).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite META lastEmailStatus when retrying an older admin message', async () => {
    requireConversation.mockResolvedValueOnce({
      conversationId: 'conv_1',
      email: 'user@example.com',
      lastMessageAuthor: 'admin',
      lastMessageAt: '2026-01-03T00:00:00.000Z',
      lastAdminMessageId: 'msg_latest',
      lastEmailStatus: 'failed',
    });
    requireMessage.mockResolvedValueOnce({
      SK: 'MSG#2026-01-01T00:00:00.000Z#msg_1',
      messageId: 'msg_1',
      author: 'admin',
      body: 'Thanks for writing in.',
      emailStatus: 'failed',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const retried = asResult(
      await handleSupportInboxAdmin(retryEmailEvent(), deps),
    );
    expect(retried.statusCode).toBe(200);
    expect(setMessageEmailStatus).toHaveBeenCalledWith({
      conversationId: 'conv_1',
      messageSk: 'MSG#2026-01-01T00:00:00.000Z#msg_1',
      emailStatus: 'sent',
      conversationLastEmailStatus: false,
    });
  });

  it('updates META lastEmailStatus when retrying the latest admin message', async () => {
    requireConversation.mockResolvedValueOnce({
      conversationId: 'conv_1',
      email: 'user@example.com',
      lastMessageAuthor: 'admin',
      lastMessageAt: '2026-01-02T00:00:00.000Z',
      lastAdminMessageId: 'msg_1',
      lastEmailStatus: 'failed',
    });

    const retried = asResult(
      await handleSupportInboxAdmin(retryEmailEvent(), deps),
    );
    expect(retried.statusCode).toBe(200);
    expect(setMessageEmailStatus).toHaveBeenCalledWith({
      conversationId: 'conv_1',
      messageSk: 'MSG#2026-01-02T00:00:00.000Z#msg_1',
      emailStatus: 'sent',
      conversationLastEmailStatus: { createdAt: '2026-01-02T00:00:00.000Z' },
    });
  });

  it.each([
    [
      'user-authored message',
      { author: 'user', emailStatus: 'failed' },
    ],
    [
      'admin message whose emailStatus is already sent',
      { author: 'admin', emailStatus: 'sent' },
    ],
  ])('retry-email returns 409 for a %s', async (_name, message) => {
    requireMessage.mockResolvedValueOnce({
      SK: 'MSG#x#msg_1',
      messageId: 'msg_1',
      body: 'Thanks for writing in.',
      ...message,
    });
    const result = asResult(
      await handleSupportInboxAdmin(
        event({
          method: 'POST',
          path: '/admin/support/conversations/conv_1/messages/msg_1/retry-email',
          routeKey:
            'POST /admin/support/conversations/{conversationId}/messages/{messageId}/retry-email',
          pathParameters: { conversationId: 'conv_1', messageId: 'msg_1' },
        }),
        deps,
      ),
    );
    expect(result.statusCode).toBe(409);
    expect(bodyOf(result)).toEqual({ error: 'not_retryable' });
    expect(sendReply).not.toHaveBeenCalled();
    expect(claimRetry).not.toHaveBeenCalled();
  });

  it('returns 404 when retrying an unknown message', async () => {
    requireMessage.mockRejectedValueOnce(new SupportNotFoundError());
    const result = asResult(
      await handleSupportInboxAdmin(
        event({
          method: 'POST',
          path: '/admin/support/conversations/conv_1/messages/missing/retry-email',
          routeKey:
            'POST /admin/support/conversations/{conversationId}/messages/{messageId}/retry-email',
          pathParameters: { conversationId: 'conv_1', messageId: 'missing' },
        }),
        deps,
      ),
    );
    expect(result.statusCode).toBe(404);
    expect(bodyOf(result)).toEqual({ error: 'not_found' });
  });
});

describe('support inbox admin reply email (WARDROBE-284)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    resetSupportInboxAlertCache();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetSupportInboxAlertCache();
  });

  it('sets Reply-To from the recipient param and leaves From unchanged', async () => {
    const http = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'email_1' }),
    }));

    const status = await sendSupportInboxReplyBestEffort(
      {
        conversationId: 'conv_1',
        messageId: 'msg_admin',
        email: 'user@example.com',
        body: 'Thanks for writing in.',
      },
      {
        env: {
          SUPPORT_FROM_EMAIL: 'Wardrobe Support <support@example.com>',
          SUPPORT_INBOX_RECIPIENT: 'inbox@example.com',
          SUPPORT_INBOX_APP_LINK: 'https://example.invalid/app/',
          RESEND_API_KEY: 're_test_placeholder',
        },
        http,
      },
    );

    expect(status).toBe('sent');
    const [, init] = http.mock.calls[0] as unknown as [
      string,
      { body?: string },
    ];
    const payload = JSON.parse(init.body ?? '{}') as {
      from: string;
      to: string[];
      reply_to?: string;
      html: string;
      text: string;
    };
    expect(payload.from).toBe('Wardrobe Support <support@example.com>');
    expect(payload.to).toEqual(['user@example.com']);
    expect(payload.reply_to).toBe('inbox@example.com');
    expect(payload.html).toContain('Open in Pocket Closet');
    expect(payload.html).toContain(
      'https://example.invalid/app/support/conv_1',
    );
    expect(payload.text).toContain(
      'https://example.invalid/app/support/conv_1',
    );
    expect(payload.text).not.toContain('https://example.invalid/app/support/conv_1/');
  });

  it('omits Reply-To and the app link when those params are missing and still sends', async () => {
    const http = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'email_1' }),
    }));

    const status = await sendSupportInboxReplyBestEffort(
      {
        conversationId: 'conv_1',
        messageId: 'msg_admin',
        email: 'user@example.com',
        body: 'Thanks for writing in.',
      },
      {
        env: {
          SUPPORT_FROM_EMAIL: 'Wardrobe Support <support@example.com>',
          RESEND_API_KEY: 're_test_placeholder',
        },
        http,
      },
    );

    expect(status).toBe('sent');
    const [, init] = http.mock.calls[0] as unknown as [
      string,
      { body?: string },
    ];
    const payload = JSON.parse(init.body ?? '{}') as {
      reply_to?: string;
      html: string;
      text: string;
    };
    expect(payload.reply_to).toBeUndefined();
    expect(payload.html).not.toContain('Open in Pocket Closet');
    expect(payload.text).toBe('Thanks for writing in.');
  });

  it('reads the app-link SSM param at runtime when the URL is not in env', async () => {
    const getParameter = jest.fn(async (name: string) => {
      if (name === '/wardrobe/dev/support/app-link') {
        return 'https://runtime.example/app';
      }
      return undefined;
    });
    const http = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'email_1' }),
    }));

    const loaded = await loadSupportInboxAppLink({
      env: {
        SUPPORT_INBOX_APP_LINK_PARAM: '/wardrobe/dev/support/app-link',
      },
      getParameter,
    });
    expect(loaded).toBe('https://runtime.example/app');
    expect(getParameter).toHaveBeenCalledWith('/wardrobe/dev/support/app-link');

    const status = await sendSupportInboxReplyBestEffort(
      {
        conversationId: 'conv_1',
        messageId: 'msg_admin',
        email: 'user@example.com',
        body: 'Thanks for writing in.',
      },
      {
        env: {
          SUPPORT_FROM_EMAIL: 'Wardrobe Support <support@example.com>',
          RESEND_API_KEY: 're_test_placeholder',
          SUPPORT_INBOX_APP_LINK_PARAM: '/wardrobe/dev/support/app-link',
        },
        getParameter,
        http,
      },
    );
    expect(status).toBe('sent');
    expect(getParameter).toHaveBeenCalledWith('/wardrobe/dev/support/app-link');
    const [, init] = http.mock.calls[0] as unknown as [
      string,
      { body?: string },
    ];
    const payload = JSON.parse(init.body ?? '{}') as { html: string; text: string };
    expect(payload.html).toContain('https://runtime.example/app/support/conv_1');
    expect(payload.text).toContain('https://runtime.example/app/support/conv_1');
  });

  it('times out Resend and records failed without leaking PII', async () => {
    expect(SUPPORT_EMAIL_TIMEOUT_MS).toBe(3000);
    const log = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const hanging = jest.fn(
      () => new Promise<{ ok: boolean; status: number; text(): Promise<string> }>(() => undefined),
    );

    const status = await sendSupportInboxReplyBestEffort(
      {
        conversationId: 'conv_timeout',
        messageId: 'msg_timeout',
        email: 'user@example.com',
        body: 'Thanks for writing in.',
      },
      {
        env: {
          SUPPORT_FROM_EMAIL: 'Wardrobe Support <support@example.com>',
          RESEND_API_KEY: SECRET_LIKE_KEY,
        },
        http: hanging,
        timeoutMs: 20,
        log,
      },
    );

    expect(status).toBe('failed');
    expect(log.error).toHaveBeenCalledWith(
      'Support inbox reply failed',
      expect.objectContaining({
        conversationId: 'conv_timeout',
        messageId: 'msg_timeout',
        error: expect.any(String),
        code: 'TIMEOUT',
      }),
    );
    assertSafeReplyFailureLog(log.error.mock.calls[0]?.[1]);
  });

  it('keeps reply failure log fields to conversationId, messageId, and error class/code', () => {
    const fields = safeReplyFailureFields(
      'conv_1',
      'msg_1',
      Object.assign(new Error('Resend send timed out'), { name: 'TimeoutError' }),
    );
    expect(fields).toEqual({
      conversationId: 'conv_1',
      messageId: 'msg_1',
      error: 'TimeoutError',
      code: 'TIMEOUT',
    });
    assertSafeReplyFailureLog(fields);
    const spy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    spy.mockRestore();
  });
});
