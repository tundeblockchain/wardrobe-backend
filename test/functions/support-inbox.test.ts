import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import {
  formatSupportInboxAlert,
  resetSupportInboxAlertCache,
  safeAlertFailureFields,
  sendSupportInboxAlertBestEffort,
} from '../../src/functions/support-inbox/alert';
import { handleSupportInbox } from '../../src/functions/support-inbox/handler';
import { conversationItems, newConversationId } from '../../src/functions/support-inbox/model';
import {
  supportPresignConditions,
  supportScreenshotObjectKey,
} from '../../src/functions/support-inbox/presign';
import {
  consumeFeedbackRateLimit,
  consumeUploadIpRateLimit,
  hashRateLimitId,
  RATE_SCOPE_FEEDBACK_EMAIL,
  RATE_SCOPE_FEEDBACK_IP,
  RATE_SCOPE_UPLOAD_IP,
} from '../../src/functions/support-inbox/rate-limit';
import { assertSupportScreenshot } from '../../src/functions/support-inbox/screenshot';
import {
  isHoneypotTripped,
  parseFeedbackBody,
  parseUploadUrlBody,
} from '../../src/functions/support-inbox/validation';
import { SupportValidationError } from '../../src/functions/support-inbox/http';
import { keys } from '../../src/functions/support-inbox/keys';
import { logger } from '../../src/shared/logger';
import {
  SUPPORT_EMAIL_TIMEOUT_MS,
  SUPPORT_PRESIGN_EXPIRES_SECONDS,
  SUPPORT_SCREENSHOT_MAX_BYTES,
} from '../../src/shared/support-inbox-names';

const MESSAGE_SK = 'MSG#2026-01-01T00:00:00.000Z#msg_1';
const SECRET_LIKE_KEY = 're_test_placeholder_key';

function assertSafeFailureLog(fields: unknown): void {
  expect(fields).toEqual(
    expect.objectContaining({
      conversationId: expect.any(String),
      error: expect.any(String),
    }),
  );
  const record = fields as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    expect(['conversationId', 'error', 'code']).toContain(key);
  }
  const blob = JSON.stringify(record);
  expect(blob).not.toContain('user@example.com');
  expect(blob).not.toContain('The try-on button does nothing.');
  expect(blob).not.toContain('Broken button');
  expect(blob).not.toMatch(/re_[A-Za-z0-9]/);
  expect(blob).not.toContain(SECRET_LIKE_KEY);
  expect(blob.toLowerCase()).not.toContain('apikey');
}

function asResult(
  result: Awaited<ReturnType<typeof handleSupportInbox>>,
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
  path: '/support/upload-url' | '/support/feedback';
  body?: unknown;
  rawBody?: string;
  method?: string;
  authorization?: string | null;
  sourceIp?: string;
}): APIGatewayProxyEventV2 {
  const headers: Record<string, string> = {};
  if (options.authorization === null) {
    // anonymous
  } else if (options.authorization !== undefined) {
    headers.authorization = options.authorization;
  }

  return {
    version: '2.0',
    routeKey: `POST ${options.path}`,
    rawPath: options.path,
    rawQueryString: '',
    headers,
    body:
      options.rawBody !== undefined
        ? options.rawBody
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'example.com',
      domainPrefix: 'example',
      http: {
        method: options.method ?? 'POST',
        path: options.path,
        protocol: 'HTTP/1.1',
        sourceIp: options.sourceIp ?? '203.0.113.9',
        userAgent: 'jest',
      },
      requestId: 'req-1',
      routeKey: `POST ${options.path}`,
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

const validFeedback = {
  type: 'bug',
  message: 'The try-on button does nothing.',
  email: 'user@example.com',
  platform: 'ios',
  appVersion: '1.2.3',
  device: 'iPhone',
};

describe('support inbox validation (WARDROBE-281)', () => {
  it('accepts a valid upload-url contentType', () => {
    expect(parseUploadUrlBody({ contentType: 'image/png' })).toEqual({
      contentType: 'image/png',
    });
    expect(parseUploadUrlBody({ contentType: ' image/jpeg ' })).toEqual({
      contentType: 'image/jpeg',
    });
  });

  it('rejects upload-url contentType that is not png or jpeg', () => {
    expect(() => parseUploadUrlBody({ contentType: 'image/webp' })).toThrow(
      SupportValidationError,
    );
    try {
      parseUploadUrlBody({ contentType: 'image/webp' });
    } catch (error) {
      expect(error).toBeInstanceOf(SupportValidationError);
      expect((error as SupportValidationError).fields).toEqual({
        contentType: 'must be image/png or image/jpeg',
      });
    }
  });

  it('rejects a non-object upload-url body', () => {
    try {
      parseUploadUrlBody([]);
    } catch (error) {
      expect((error as SupportValidationError).fields.body).toBeDefined();
    }
  });

  it.each([
    ['type', { ...validFeedback, type: 'idea' }, 'type'],
    ['message', { ...validFeedback, message: '' }, 'message'],
    ['message length', { ...validFeedback, message: 'x'.repeat(5001) }, 'message'],
    ['email', { ...validFeedback, email: 'not-an-email' }, 'email'],
    ['platform', { ...validFeedback, platform: 'desktop' }, 'platform'],
    [
      'screenshotKey',
      { ...validFeedback, screenshotKey: 'users/uid/secret.png' },
      'screenshotKey',
    ],
    [
      'device',
      { ...validFeedback, device: 'd'.repeat(201) },
      'device',
    ],
    [
      'appVersion',
      { ...validFeedback, appVersion: 'v'.repeat(65) },
      'appVersion',
    ],
  ])('rejects invalid %s', (_name, body, field) => {
    try {
      parseFeedbackBody(body);
      throw new Error('expected validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(SupportValidationError);
      expect(
        (error as SupportValidationError).fields[field],
      ).toEqual(expect.any(String));
    }
  });

  it('trims message and accepts the 1-5000 range', () => {
    const parsed = parseFeedbackBody({
      ...validFeedback,
      message: '  hello  ',
    });
    expect(parsed).toEqual({
      honeypot: false,
      value: expect.objectContaining({ message: 'hello' }),
    });
  });

  it('treats a non-empty website field as a honeypot', () => {
    expect(isHoneypotTripped('https://spam.example')).toBe(true);
    expect(isHoneypotTripped('  bots  ')).toBe(true);
    expect(isHoneypotTripped('')).toBe(false);
    expect(isHoneypotTripped('   ')).toBe(false);
    expect(parseFeedbackBody({ website: 'x', type: 'nope' })).toEqual({
      honeypot: true,
    });
  });
});

describe('support inbox handler (WARDROBE-281)', () => {
  const persistConversation = jest.fn(async (input: { conversationId: string }) => ({
    conversationId: input.conversationId,
    messageSk: MESSAGE_SK,
  }));
  const setMessageEmailStatus = jest.fn(async () => undefined);
  const createUploadPost = jest.fn(async () => ({
    url: 'https://s3.example/support',
    fields: { key: 'support/abc.png', Policy: 'policy', 'X-Amz-Signature': 'sig' },
    screenshotKey: 'support/abc.png',
  }));
  const headScreenshot = jest.fn(async () => ({ contentLength: 1024 }));
  const verifyIdToken = jest.fn(async () => 'firebase-uid-1');
  const consumeUploadRateLimit = jest.fn(async () => ({
    allowed: true,
    retryAfterSeconds: 3600,
    count: 1,
  }));
  const consumeFeedbackRateLimitFn = jest.fn(async () => ({
    allowed: true,
    retryAfterSeconds: 3600,
    count: 1,
  }));
  const sendAlert = jest.fn(async () => undefined);

  const deps = {
    persistConversation,
    setMessageEmailStatus,
    createUploadPost,
    headScreenshot,
    verifyIdToken,
    consumeUploadRateLimit,
    consumeFeedbackRateLimit: consumeFeedbackRateLimitFn,
    newConversationId: () => 'conv_testhoneypot01',
    alert: { sendAlert },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a presigned POST for a valid upload-url request', async () => {
    const result = asResult(
      await handleSupportInbox(
        event({
          path: '/support/upload-url',
          authorization: null,
          body: { contentType: 'image/png' },
        }),
        deps,
      ),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual({
      url: 'https://s3.example/support',
      fields: expect.objectContaining({ Policy: 'policy' }),
      screenshotKey: 'support/abc.png',
    });
    expect(consumeUploadRateLimit).toHaveBeenCalledWith('203.0.113.9');
    expect(createUploadPost).toHaveBeenCalledWith({ contentType: 'image/png' });
  });

  it('rate-limits upload-url with 429 and Retry-After', async () => {
    consumeUploadRateLimit.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 17,
      count: 21,
    });

    const result = asResult(
      await handleSupportInbox(
        event({
          path: '/support/upload-url',
          authorization: null,
          body: { contentType: 'image/jpeg' },
        }),
        deps,
      ),
    );

    expect(result.statusCode).toBe(429);
    expect(result.headers?.['Retry-After']).toBe('17');
    expect(bodyOf(result)).toEqual({
      error: 'rate_limited',
      retryAfterSeconds: 17,
    });
    expect(createUploadPost).not.toHaveBeenCalled();
  });

  it('stores feedback, links a valid Firebase uid, and returns 201', async () => {
    const result = asResult(
      await handleSupportInbox(
        event({
          path: '/support/feedback',
          authorization: 'Bearer valid-token',
          body: validFeedback,
        }),
        deps,
      ),
    );

    expect(result.statusCode).toBe(201);
    expect(bodyOf(result)).toEqual({ conversationId: 'conv_testhoneypot01' });
    expect(verifyIdToken).toHaveBeenCalledWith('valid-token');
    expect(persistConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv_testhoneypot01',
        uid: 'firebase-uid-1',
        email: 'user@example.com',
        type: 'bug',
      }),
    );
    expect(sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv_testhoneypot01',
        uid: 'firebase-uid-1',
        email: 'user@example.com',
      }),
    );
    expect(setMessageEmailStatus).toHaveBeenCalledWith({
      conversationId: 'conv_testhoneypot01',
      messageSk: MESSAGE_SK,
      emailStatus: 'sent',
    });
  });

  it('writes META+MSG before calling Resend', async () => {
    const order: string[] = [];
    persistConversation.mockImplementation(async (input: { conversationId: string }) => {
      order.push('put');
      return { conversationId: input.conversationId, messageSk: MESSAGE_SK };
    });
    sendAlert.mockImplementation(async () => {
      order.push('send');
    });
    setMessageEmailStatus.mockImplementation(async () => {
      order.push('status');
    });

    await handleSupportInbox(
      event({
        path: '/support/feedback',
        authorization: null,
        body: validFeedback,
      }),
      deps,
    );

    expect(order).toEqual(['put', 'send', 'status']);
  });

  it('returns 401 for an invalid Firebase token and stores nothing', async () => {
    verifyIdToken.mockRejectedValueOnce(new Error('JWTExpired'));

    const result = asResult(
      await handleSupportInbox(
        event({
          path: '/support/feedback',
          authorization: 'Bearer definitely-invalid',
          body: validFeedback,
        }),
        deps,
      ),
    );

    expect(result.statusCode).toBe(401);
    expect(bodyOf(result)).toEqual({ error: 'unauthenticated' });
    expect(persistConversation).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('allows anonymous feedback with no Authorization header', async () => {
    const result = asResult(
      await handleSupportInbox(
        event({
          path: '/support/feedback',
          authorization: null,
          body: validFeedback,
        }),
        deps,
      ),
    );

    expect(result.statusCode).toBe(201);
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(persistConversation).toHaveBeenCalledWith(
      expect.objectContaining({ uid: undefined }),
    );
  });

  it('returns a fake 201 on honeypot without storing or emailing', async () => {
    const result = asResult(
      await handleSupportInbox(
        event({
          path: '/support/feedback',
          authorization: null,
          body: { ...validFeedback, website: 'http://spam.test' },
        }),
        deps,
      ),
    );

    expect(result.statusCode).toBe(201);
    expect(bodyOf(result)).toEqual({ conversationId: 'conv_testhoneypot01' });
    expect(persistConversation).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
    expect(consumeFeedbackRateLimitFn).not.toHaveBeenCalled();
  });

  it('rate-limits feedback with 429 and Retry-After', async () => {
    consumeFeedbackRateLimitFn.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 9,
      count: 6,
    });

    const result = asResult(
      await handleSupportInbox(
        event({
          path: '/support/feedback',
          authorization: null,
          body: validFeedback,
        }),
        deps,
      ),
    );

    expect(result.statusCode).toBe(429);
    expect(result.headers?.['Retry-After']).toBe('9');
    expect(bodyOf(result)).toEqual({
      error: 'rate_limited',
      retryAfterSeconds: 9,
    });
    expect(persistConversation).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('returns 400 validation when screenshot HeadObject fails', async () => {
    const missing = Object.assign(new Error('NotFound'), { name: 'NotFound' });
    headScreenshot.mockRejectedValueOnce(missing);

    const result = asResult(
      await handleSupportInbox(
        event({
          path: '/support/feedback',
          authorization: null,
          body: { ...validFeedback, screenshotKey: 'support/missing.png' },
        }),
        deps,
      ),
    );

    expect(result.statusCode).toBe(400);
    expect(bodyOf(result)).toEqual({
      error: 'validation',
      fields: {
        screenshotKey: 'must exist under support/ and be 5 MB or smaller',
      },
    });
    expect(persistConversation).not.toHaveBeenCalled();
  });

  it('returns 400 validation when screenshot exceeds 5 MB', async () => {
    headScreenshot.mockResolvedValueOnce({
      contentLength: SUPPORT_SCREENSHOT_MAX_BYTES + 1,
    });

    const result = asResult(
      await handleSupportInbox(
        event({
          path: '/support/feedback',
          authorization: null,
          body: { ...validFeedback, screenshotKey: 'support/huge.png' },
        }),
        deps,
      ),
    );

    expect(result.statusCode).toBe(400);
    expect((bodyOf(result) as { fields: { screenshotKey: string } }).fields
      .screenshotKey).toBeDefined();
    expect(persistConversation).not.toHaveBeenCalled();
  });

  it('returns 400 validation fields for each invalid feedback field', async () => {
    const result = asResult(
      await handleSupportInbox(
        event({
          path: '/support/feedback',
          authorization: null,
          body: {
            type: 'nope',
            message: '',
            email: 'bad',
            platform: 'desktop',
            device: 'x'.repeat(201),
            screenshotKey: '../etc/passwd',
          },
        }),
        deps,
      ),
    );

    expect(result.statusCode).toBe(400);
    const body = bodyOf(result) as {
      error: string;
      fields: Record<string, string>;
    };
    expect(body.error).toBe('validation');
    expect(body.fields).toEqual(
      expect.objectContaining({
        type: expect.any(String),
        message: expect.any(String),
        email: expect.any(String),
        platform: expect.any(String),
        device: expect.any(String),
        screenshotKey: expect.any(String),
      }),
    );
  });

  it('returns 201 with emailStatus failed when Resend throws', async () => {
    const logError = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    sendAlert.mockRejectedValueOnce(
      Object.assign(new Error('Resend down'), { name: 'ResendError' }),
    );

    const result = asResult(
      await handleSupportInbox(
        event({
          path: '/support/feedback',
          authorization: null,
          body: validFeedback,
        }),
        deps,
      ),
    );

    expect(result.statusCode).toBe(201);
    expect(bodyOf(result)).toEqual({ conversationId: 'conv_testhoneypot01' });
    expect(persistConversation).toHaveBeenCalled();
    expect(setMessageEmailStatus).toHaveBeenCalledWith({
      conversationId: 'conv_testhoneypot01',
      messageSk: MESSAGE_SK,
      emailStatus: 'failed',
    });
    expect(logError).toHaveBeenCalled();
    const failureLog = logError.mock.calls.find(
      ([message]) => message === 'Support inbox alert failed',
    );
    expect(failureLog).toBeDefined();
    assertSafeFailureLog(failureLog?.[1]);
    logError.mockRestore();
  });

  it('returns 201 with emailStatus failed when Resend times out', async () => {
    const logError = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    sendAlert.mockRejectedValueOnce(
      Object.assign(new Error('Resend send timed out'), { name: 'TimeoutError' }),
    );

    const result = asResult(
      await handleSupportInbox(
        event({
          path: '/support/feedback',
          authorization: null,
          body: validFeedback,
        }),
        deps,
      ),
    );

    expect(result.statusCode).toBe(201);
    expect(persistConversation).toHaveBeenCalled();
    expect(setMessageEmailStatus).toHaveBeenCalledWith({
      conversationId: 'conv_testhoneypot01',
      messageSk: MESSAGE_SK,
      emailStatus: 'failed',
    });
    const failureLog = logError.mock.calls.find(
      ([message]) => message === 'Support inbox alert failed',
    );
    expect(failureLog).toBeDefined();
    assertSafeFailureLog(failureLog?.[1]);
    logError.mockRestore();
  });
});

describe('support inbox presign conditions (WARDROBE-281)', () => {
  it('locks content-length-range and exact Content-Type', () => {
    expect(supportPresignConditions('image/png')).toEqual([
      ['content-length-range', 1, SUPPORT_SCREENSHOT_MAX_BYTES],
      ['eq', '$Content-Type', 'image/png'],
    ]);
    expect(supportPresignConditions('image/jpeg')).toEqual([
      ['content-length-range', 1, 5_242_880],
      ['eq', '$Content-Type', 'image/jpeg'],
    ]);
    expect(SUPPORT_PRESIGN_EXPIRES_SECONDS).toBe(900);
  });

  it('places keys under the support/ prefix', () => {
    expect(supportScreenshotObjectKey('image/png', 'abc')).toBe(
      'support/abc.png',
    );
    expect(supportScreenshotObjectKey('image/jpeg', 'xyz')).toBe(
      'support/xyz.jpg',
    );
  });
});

describe('support inbox screenshot HeadObject (WARDROBE-281)', () => {
  it('rejects keys outside support/', async () => {
    const head = jest.fn();
    await expect(
      assertSupportScreenshot('users/uid/photo.png', head),
    ).rejects.toBeInstanceOf(SupportValidationError);
    expect(head).not.toHaveBeenCalled();
  });

  it('rejects a missing object', async () => {
    const head = jest.fn(async () => {
      throw Object.assign(new Error('missing'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      });
    });
    await expect(
      assertSupportScreenshot('support/gone.png', head),
    ).rejects.toMatchObject({
      fields: {
        screenshotKey: 'must exist under support/ and be 5 MB or smaller',
      },
    });
  });

  it('rejects an object larger than 5 MB', async () => {
    const head = jest.fn(async () => ({
      contentLength: SUPPORT_SCREENSHOT_MAX_BYTES + 10,
    }));
    await expect(
      assertSupportScreenshot('support/big.png', head),
    ).rejects.toBeInstanceOf(SupportValidationError);
  });

  it('accepts an existing support/ object within the size limit', async () => {
    const head = jest.fn(async () => ({ contentLength: 2048 }));
    await expect(
      assertSupportScreenshot('support/ok.png', head),
    ).resolves.toBeUndefined();
  });
});

describe('support inbox rate-limit counters (WARDROBE-281)', () => {
  it('uses hashed IP keys and TTL windows for upload-url', async () => {
    const increment = jest.fn(async () => 1);
    const decision = await consumeUploadIpRateLimit(
      '203.0.113.9',
      increment,
      1_700_000_000_000,
      { SUPPORT_UPLOAD_IP_RATE_LIMIT: '20', SUPPORT_INBOX_RATE_WINDOW_SECONDS: '3600' },
    );
    expect(decision.allowed).toBe(true);
    expect(increment).toHaveBeenCalledWith(
      expect.objectContaining({
        pk: keys.rateLimitPk(
          RATE_SCOPE_UPLOAD_IP,
          hashRateLimitId('203.0.113.9'),
        ),
        ttl: expect.any(Number),
      }),
    );
  });

  it('rate-limits feedback per IP and per email', async () => {
    const increment = jest
      .fn()
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce(1);
    const decision = await consumeFeedbackRateLimit(
      '203.0.113.9',
      'User@Example.com',
      increment,
      1_700_000_000_000,
      {
        SUPPORT_FEEDBACK_IP_RATE_LIMIT: '5',
        SUPPORT_FEEDBACK_EMAIL_RATE_LIMIT: '5',
        SUPPORT_INBOX_RATE_WINDOW_SECONDS: '3600',
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    expect(increment).toHaveBeenCalledWith(
      expect.objectContaining({
        pk: keys.rateLimitPk(
          RATE_SCOPE_FEEDBACK_IP,
          hashRateLimitId('203.0.113.9'),
        ),
      }),
    );
    expect(increment).toHaveBeenCalledWith(
      expect.objectContaining({
        pk: keys.rateLimitPk(
          RATE_SCOPE_FEEDBACK_EMAIL,
          hashRateLimitId('user@example.com'),
        ),
      }),
    );
  });
});

describe('support inbox conversation items (WARDROBE-281)', () => {
  it('uses CONV# pk with META and MSG# items and GSI fields', () => {
    const [meta, message] = conversationItems({
      conversationId: 'conv_1',
      messageId: 'msg_1',
      createdAt: '2026-01-01T00:00:00.000Z',
      type: 'query',
      message: 'How do I export?',
      email: 'user@example.com',
      platform: 'web',
      uid: 'firebase-uid-1',
      screenshotKey: 'support/abc.png',
    });
    expect(meta).toEqual(
      expect.objectContaining({
        PK: 'CONV#conv_1',
        SK: 'META',
        status: 'open',
        uid: 'firebase-uid-1',
        lastMessageAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    expect(message).toEqual(
      expect.objectContaining({
        PK: 'CONV#conv_1',
        SK: 'MSG#2026-01-01T00:00:00.000Z#msg_1',
        author: 'user',
      }),
    );
    expect(newConversationId()).toMatch(/^conv_[A-Za-z0-9_-]{16}$/);
  });
});

describe('support inbox alert email (WARDROBE-281)', () => {
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

  it('sets Reply-To to the user and leaves From as the verified sender', async () => {
    const http = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'email_1' }),
    }));

    await sendSupportInboxAlertBestEffort(
      {
        conversationId: 'conv_1',
        type: 'bug',
        message: 'Broken button',
        email: 'user@example.com',
        platform: 'android',
        appVersion: '2.0.0',
        device: 'Pixel',
        uid: 'uid-1',
        screenshotKey: 'support/a.png',
      },
      {
        env: {
          SUPPORT_FROM_EMAIL: 'Wardrobe Support <support@example.com>',
          SUPPORT_INBOX_RECIPIENT: 'inbox@example.com',
          RESEND_API_KEY: 're_test_placeholder',
        },
        http,
      },
    );

    expect(http).toHaveBeenCalledTimes(1);
    const [, init] = http.mock.calls[0] as unknown as [
      string,
      { body?: string; headers?: Record<string, string> },
    ];
    const payload = JSON.parse(init.body ?? '{}') as {
      from: string;
      reply_to: string;
      to: string[];
      text: string;
    };
    expect(payload.from).toBe('Wardrobe Support <support@example.com>');
    expect(payload.reply_to).toBe('user@example.com');
    expect(payload.from).not.toBe(payload.reply_to);
    expect(payload.to).toEqual(['inbox@example.com']);
    expect(payload.text).toContain('conv_1');
    expect(payload.text).toContain('uid-1');
    expect(payload.text).toContain('Screenshot: yes');
    expect(init.headers?.Authorization).toMatch(/^Bearer /);
  });

  it('stores the conversation path: missing recipient still 201 and does not throw', async () => {
    const logError = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    const persistConversation = jest.fn(async (input: { conversationId: string }) => ({
      conversationId: input.conversationId,
      messageSk: MESSAGE_SK,
    }));
    const setMessageEmailStatus = jest.fn(async () => undefined);

    const result = asResult(
      await handleSupportInbox(
        event({
          path: '/support/feedback',
          authorization: null,
          body: validFeedback,
        }),
        {
          persistConversation,
          setMessageEmailStatus,
          consumeFeedbackRateLimit: async () => ({
            allowed: true,
            retryAfterSeconds: 1,
            count: 1,
          }),
          newConversationId: () => 'conv_missingrecipient',
          alert: {
            env: {
              SUPPORT_FROM_EMAIL: 'Wardrobe Support <support@example.com>',
              SUPPORT_INBOX_RECIPIENT_PARAM: '/wardrobe/dev/support/recipient',
            },
            getParameter: async () => undefined,
            http: async () => {
              throw new Error('should not send');
            },
          },
        },
      ),
    );

    expect(result.statusCode).toBe(201);
    expect(bodyOf(result)).toEqual({
      conversationId: 'conv_missingrecipient',
    });
    expect(persistConversation).toHaveBeenCalled();
    expect(setMessageEmailStatus).toHaveBeenCalledWith({
      conversationId: 'conv_missingrecipient',
      messageSk: MESSAGE_SK,
      emailStatus: 'failed',
    });
    const failureLog = logError.mock.calls.find(
      ([message]) => message === 'Support inbox alert failed',
    );
    expect(failureLog).toBeDefined();
    assertSafeFailureLog(failureLog?.[1]);
    logError.mockRestore();
  });

  it('times out Resend and records emailStatus failed without leaking PII', async () => {
    expect(SUPPORT_EMAIL_TIMEOUT_MS).toBe(3000);
    const log = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const hanging = jest.fn(
      () => new Promise<{ ok: boolean; status: number; text(): Promise<string> }>(() => undefined),
    );

    const status = await sendSupportInboxAlertBestEffort(
      {
        conversationId: 'conv_timeout',
        type: 'bug',
        message: 'Broken button',
        email: 'user@example.com',
        platform: 'ios',
      },
      {
        env: {
          SUPPORT_FROM_EMAIL: 'Wardrobe Support <support@example.com>',
          SUPPORT_INBOX_RECIPIENT: 'inbox@example.com',
          RESEND_API_KEY: SECRET_LIKE_KEY,
        },
        http: hanging,
        timeoutMs: 20,
        log,
      },
    );

    expect(status).toBe('failed');
    expect(log.error).toHaveBeenCalledWith(
      'Support inbox alert failed',
      expect.objectContaining({
        conversationId: 'conv_timeout',
        error: expect.any(String),
        code: 'TIMEOUT',
      }),
    );
    assertSafeFailureLog(log.error.mock.calls[0]?.[1]);
  });

  it('returns sent on a successful Resend call', async () => {
    const status = await sendSupportInboxAlertBestEffort(
      {
        conversationId: 'conv_ok',
        type: 'query',
        message: 'How do I share?',
        email: 'user@example.com',
        platform: 'web',
      },
      {
        env: {
          SUPPORT_FROM_EMAIL: 'Wardrobe Support <support@example.com>',
          SUPPORT_INBOX_RECIPIENT: 'inbox@example.com',
          RESEND_API_KEY: SECRET_LIKE_KEY,
        },
        http: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: 'email_1' }),
        }),
      },
    );
    expect(status).toBe('sent');
  });

  it('keeps failure log fields to conversationId and error class/code', () => {
    const fields = safeAlertFailureFields(
      'conv_1',
      Object.assign(new Error('Resend send timed out'), { name: 'TimeoutError' }),
    );
    expect(fields).toEqual({
      conversationId: 'conv_1',
      error: 'TimeoutError',
      code: 'TIMEOUT',
    });
    assertSafeFailureLog(fields);
  });

  it('formats type, message, platform, and screenshot presence', () => {
    const formatted = formatSupportInboxAlert({
      conversationId: 'conv_9',
      type: 'query',
      message: 'How do I share?',
      email: 'a@b.co',
      platform: 'web',
    });
    expect(formatted.subject).toContain('query');
    expect(formatted.subject).toContain('conv_9');
    expect(formatted.text).toContain('How do I share?');
    expect(formatted.text).toContain('Screenshot: no');
    expect(formatted.text).toContain('web');
  });
});
