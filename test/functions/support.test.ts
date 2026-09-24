import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { handleSupport } from '../../src/functions/support/handler';
import { parseSupportMailSecret } from '../../src/functions/support/config';
import { isOriginAllowed, parseAllowedOrigins } from '../../src/functions/support/origins';
import {
  consumeContactRateLimit,
  hashIp,
} from '../../src/functions/support/rate-limit';
import {
  formatInboundForward,
  formatOutboundMail,
} from '../../src/functions/support/resend';
import {
  isHoneypotTripped,
  parseSupportMessage,
  parseWebsiteContact,
} from '../../src/functions/support/validation';
import { logger } from '../../src/shared/logger';

function asResult(
  result: Awaited<ReturnType<typeof handleSupport>>,
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
  path: '/support/contact' | '/support/bug';
  body?: unknown;
  rawBody?: string;
  sub?: string | null;
  method?: string;
  authorization?: string | null;
  origin?: string;
  sourceIp?: string;
  isBase64Encoded?: boolean;
}): APIGatewayProxyEventV2 {
  const authorizer =
    options.sub === null
      ? undefined
      : {
          lambda: { sub: options.sub ?? 'firebase-uid-owner' },
        };

  const headers: Record<string, string> = {};
  if (options.authorization === null) {
    // anonymous website path
  } else if (options.authorization !== undefined) {
    headers.authorization = options.authorization;
  } else {
    headers.authorization = 'Bearer unused-in-handler';
  }
  if (options.origin) {
    headers.origin = options.origin;
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
        sourceIp: options.sourceIp ?? '127.0.0.1',
        userAgent: 'jest',
      },
      requestId: 'req-1',
      routeKey: `POST ${options.path}`,
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
      authorizer,
    },
    isBase64Encoded: options.isBase64Encoded ?? false,
  } as unknown as APIGatewayProxyEventV2;
}

const websiteBody = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  message: 'I would like a demo of Pocket Closet.',
};

describe('support outbound (WARDROBE-38 / WARDROBE-143)', () => {
  const sendEmail = jest.fn();
  const loadConfig = jest.fn();
  const verifyIdToken = jest.fn();
  const consumeRateLimit = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SUPPORT_CONTACT_ALLOWED_ORIGINS;
    loadConfig.mockResolvedValue({
      apiKey: 're_test_key',
      webhookSecret: 'whsec_test',
      fromEmail: 'Wardrobe Support <support@example.test>',
      forwardTo: 'tunde@example.test',
    });
    sendEmail.mockResolvedValue({ id: 'email_123' });
    verifyIdToken.mockResolvedValue('firebase-uid-owner');
    consumeRateLimit.mockResolvedValue({
      allowed: true,
      retryAfterSeconds: 3600,
      count: 1,
    });
  });

  afterEach(() => {
    delete process.env.SUPPORT_CONTACT_ALLOWED_ORIGINS;
  });

  it('sends a contact form through the injected Resend client', async () => {
    const result = asResult(
      await handleSupport(
        event({
          path: '/support/contact',
          body: {
            subject: 'Upload stuck',
            body: 'The camera sheet hangs after I pick a photo.',
            replyTo: 'user@example.com',
            meta: { appVersion: '1.0.0', platform: 'ios' },
          },
        }),
        { loadConfig, sendEmail, verifyIdToken },
      ),
    );

    expect(result.statusCode).toBe(202);
    expect(bodyOf(result)).toEqual({
      status: 'sent',
      kind: 'contact',
      source: 'app',
      id: 'email_123',
    });
    expect(verifyIdToken).toHaveBeenCalledWith('unused-in-handler');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 're_test_key',
        from: 'Wardrobe Support <support@example.test>',
        to: 'tunde@example.test',
        replyTo: 'user@example.com',
        subject: '[Wardrobe Contact us] Upload stuck',
      }),
    );
    const sent = sendEmail.mock.calls[0][0] as { text: string };
    expect(sent.text).toContain('User ID: firebase-uid-owner');
    expect(sent.text).toContain('appVersion: 1.0.0');
    expect(sent.text).not.toContain('Source: website');
  });

  it('sends a bug report with the bug subject prefix', async () => {
    const result = asResult(
      await handleSupport(
        event({
          path: '/support/bug',
          body: { subject: 'Crash on save', body: 'Outfit save dies.' },
        }),
        { loadConfig, sendEmail, verifyIdToken },
      ),
    );

    expect(result.statusCode).toBe(202);
    expect(bodyOf(result)).toEqual({
      status: 'sent',
      kind: 'bug',
      source: 'app',
      id: 'email_123',
    });
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(sendEmail.mock.calls[0][0].subject).toBe(
      '[Wardrobe Bug report] Crash on save',
    );
  });

  it('rejects a present-but-invalid Firebase token with 401 UNAUTHORIZED', async () => {
    verifyIdToken.mockRejectedValue(new Error('JWTExpired'));

    const result = asResult(
      await handleSupport(
        event({
          path: '/support/contact',
          body: { subject: 'Hi', body: 'Hello' },
          sub: null,
        }),
        { loadConfig, sendEmail, verifyIdToken },
      ),
    );

    expect(result.statusCode).toBe(401);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: expect.any(String),
      },
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('does not downgrade an invalid token to the website path', async () => {
    verifyIdToken.mockRejectedValue(new Error('JWTExpired'));

    const result = asResult(
      await handleSupport(
        event({
          path: '/support/contact',
          authorization: 'Bearer definitely-invalid',
          origin: 'https://pocketcloset.app',
          body: websiteBody,
          sub: null,
        }),
        { loadConfig, sendEmail, verifyIdToken, consumeRateLimit },
      ),
    );

    expect(result.statusCode).toBe(401);
    expect((bodyOf(result) as { error: { code: string } }).error.code).toBe(
      'UNAUTHORIZED',
    );
    expect(sendEmail).not.toHaveBeenCalled();
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });

  it('still requires Firebase identity on /support/bug', async () => {
    const result = asResult(
      await handleSupport(
        event({
          path: '/support/bug',
          body: { subject: 'Hi', body: 'Hello' },
          sub: null,
          authorization: null,
        }),
        { loadConfig, sendEmail, verifyIdToken },
      ),
    );

    expect(result.statusCode).toBe(401);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'UNAUTHENTICATED',
        message: expect.any(String),
      },
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('rejects a missing subject on the authed path', async () => {
    const result = asResult(
      await handleSupport(
        event({
          path: '/support/contact',
          body: { body: 'No subject' },
        }),
        { loadConfig, sendEmail, verifyIdToken },
      ),
    );

    expect(result.statusCode).toBe(400);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.any(String),
      },
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('maps Resend send failures to INTERNAL_ERROR', async () => {
    sendEmail.mockRejectedValue(new Error('Resend send HTTP 401'));

    const result = asResult(
      await handleSupport(
        event({
          path: '/support/contact',
          body: { subject: 'Hi', body: 'Hello' },
        }),
        { loadConfig, sendEmail, verifyIdToken },
      ),
    );

    expect(result.statusCode).toBe(500);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      },
    });
  });

  it('rate-limits using requestContext.http.sourceIp and ignores X-Forwarded-For', async () => {
    const result = asResult(
      await handleSupport(
        event({
          path: '/support/contact',
          authorization: null,
          sourceIp: '203.0.113.9',
          body: websiteBody,
        }),
        { loadConfig, sendEmail, consumeRateLimit },
      ),
    );

    // Inject a spoofed forwarded-for header after the event is built.
    const spoofed = event({
      path: '/support/contact',
      authorization: null,
      sourceIp: '203.0.113.9',
      body: websiteBody,
    });
    spoofed.headers = {
      ...spoofed.headers,
      'x-forwarded-for': '198.51.100.1, 192.0.2.1',
    };

    await handleSupport(spoofed, { loadConfig, sendEmail, consumeRateLimit });

    expect(result.statusCode).toBe(202);
    expect(consumeRateLimit).toHaveBeenCalledWith('203.0.113.9');
    expect(consumeRateLimit).not.toHaveBeenCalledWith('198.51.100.1');
    expect(consumeRateLimit).not.toHaveBeenCalledWith(
      expect.stringContaining('198.51.100'),
    );
  });

  it('sends an anonymous website contact with the website tag', async () => {
    const result = asResult(
      await handleSupport(
        event({
          path: '/support/contact',
          authorization: null,
          body: websiteBody,
        }),
        { loadConfig, sendEmail, verifyIdToken, consumeRateLimit },
      ),
    );

    expect(result.statusCode).toBe(202);
    expect(bodyOf(result)).toEqual({
      status: 'sent',
      kind: 'contact',
      source: 'website',
      id: 'email_123',
    });
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(consumeRateLimit).toHaveBeenCalledWith('127.0.0.1');
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        replyTo: 'ada@example.com',
        subject: '[Website] Website contact from Ada Lovelace',
      }),
    );
    const sent = sendEmail.mock.calls[0][0] as { text: string };
    expect(sent.text).toContain('Source: website');
    expect(sent.text).toContain('Name: Ada Lovelace');
    expect(sent.text).not.toContain('User ID:');
  });

  it.each([
    ['name', { email: 'ada@example.com', message: 'Hello' }],
    ['email', { name: 'Ada', message: 'Hello' }],
    ['message', { name: 'Ada', email: 'ada@example.com' }],
  ])('rejects a missing %s on the website path', async (_field, body) => {
    const result = asResult(
      await handleSupport(
        event({
          path: '/support/contact',
          authorization: null,
          body,
        }),
        { loadConfig, sendEmail, consumeRateLimit },
      ),
    );

    expect(result.statusCode).toBe(400);
    expect((bodyOf(result) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_ERROR',
    );
    expect(sendEmail).not.toHaveBeenCalled();
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });

  it.each([
    ['name', { ...websiteBody, name: 'x'.repeat(101) }],
    ['email', { ...websiteBody, email: `${'a'.repeat(250)}@x.io` }],
    ['message', { ...websiteBody, message: 'x'.repeat(5001) }],
    ['subject', { ...websiteBody, subject: 'x'.repeat(201) }],
  ])('rejects a too-long %s on the website path', async (_field, body) => {
    const result = asResult(
      await handleSupport(
        event({
          path: '/support/contact',
          authorization: null,
          body,
        }),
        { loadConfig, sendEmail, consumeRateLimit },
      ),
    );

    expect(result.statusCode).toBe(400);
    expect((bodyOf(result) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_ERROR',
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('rejects an invalid website email', async () => {
    const result = asResult(
      await handleSupport(
        event({
          path: '/support/contact',
          authorization: null,
          body: { ...websiteBody, email: 'not-an-email' },
        }),
        { loadConfig, sendEmail, consumeRateLimit },
      ),
    );

    expect(result.statusCode).toBe(400);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.stringMatching(/email/i),
      },
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('returns 202 for a honeypot without sending or rate-limiting', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);

    const result = asResult(
      await handleSupport(
        event({
          path: '/support/contact',
          authorization: null,
          body: { company: 'Acme Bot Farm', ...websiteBody },
        }),
        { loadConfig, sendEmail, consumeRateLimit },
      ),
    );

    expect(result.statusCode).toBe(202);
    expect(bodyOf(result)).toEqual({
      status: 'sent',
      kind: 'contact',
      source: 'website',
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(consumeRateLimit).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      'support.contact.honeypot',
      expect.objectContaining({ metric: 'SupportContactHoneypot' }),
    );
    info.mockRestore();
  });

  it('rate-limits the anonymous path after N requests', async () => {
    let count = 0;
    consumeRateLimit.mockImplementation(async () => {
      count += 1;
      return {
        allowed: count <= 5,
        retryAfterSeconds: 42,
        count,
      };
    });

    for (let i = 0; i < 5; i += 1) {
      const allowed = asResult(
        await handleSupport(
          event({
            path: '/support/contact',
            authorization: null,
            body: websiteBody,
          }),
          { loadConfig, sendEmail, consumeRateLimit },
        ),
      );
      expect(allowed.statusCode).toBe(202);
    }

    const limited = asResult(
      await handleSupport(
        event({
          path: '/support/contact',
          authorization: null,
          body: websiteBody,
        }),
        { loadConfig, sendEmail, consumeRateLimit },
      ),
    );

    expect(limited.statusCode).toBe(429);
    expect(limited.headers?.['Retry-After']).toBe('42');
    expect(bodyOf(limited)).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: expect.any(String),
      },
    });
    expect(sendEmail).toHaveBeenCalledTimes(5);
  });

  it('rejects a disallowed Origin on the anonymous path', async () => {
    process.env.SUPPORT_CONTACT_ALLOWED_ORIGINS = 'https://pocketcloset.app';

    const result = asResult(
      await handleSupport(
        event({
          path: '/support/contact',
          authorization: null,
          origin: 'https://evil.example',
          body: websiteBody,
        }),
        { loadConfig, sendEmail, consumeRateLimit },
      ),
    );

    expect(result.statusCode).toBe(403);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'ORIGIN_NOT_ALLOWED',
        message: expect.any(String),
      },
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('rejects Origin-bearing anonymous calls when the allowlist is empty', async () => {
    delete process.env.SUPPORT_CONTACT_ALLOWED_ORIGINS;

    const result = asResult(
      await handleSupport(
        event({
          path: '/support/contact',
          authorization: null,
          origin: 'https://pocketcloset.app',
          body: websiteBody,
        }),
        { loadConfig, sendEmail, consumeRateLimit },
      ),
    );

    expect(result.statusCode).toBe(403);
    expect((bodyOf(result) as { error: { code: string } }).error.code).toBe(
      'ORIGIN_NOT_ALLOWED',
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('allows a Netlify deploy-preview wildcard origin', async () => {
    process.env.SUPPORT_CONTACT_ALLOWED_ORIGINS =
      'https://pocketcloset.app,https://*--pocket-closet.netlify.app';

    const result = asResult(
      await handleSupport(
        event({
          path: '/support/contact',
          authorization: null,
          origin: 'https://deploy-preview-12--pocket-closet.netlify.app',
          body: websiteBody,
        }),
        { loadConfig, sendEmail, consumeRateLimit },
      ),
    );

    expect(result.statusCode).toBe(202);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('does not apply the origin allowlist to a valid Firebase token', async () => {
    delete process.env.SUPPORT_CONTACT_ALLOWED_ORIGINS;

    const result = asResult(
      await handleSupport(
        event({
          path: '/support/contact',
          origin: 'https://evil.example',
          body: { subject: 'Hi', body: 'Hello from the app' },
        }),
        { loadConfig, sendEmail, verifyIdToken },
      ),
    );

    expect(result.statusCode).toBe(202);
    expect((bodyOf(result) as { source: string }).source).toBe('app');
  });

  it('rejects an oversize raw body before parsing', async () => {
    const result = asResult(
      await handleSupport(
        event({
          path: '/support/contact',
          authorization: null,
          rawBody: 'x'.repeat(16 * 1024 + 1),
        }),
        { loadConfig, sendEmail, consumeRateLimit },
      ),
    );

    expect(result.statusCode).toBe(413);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.any(String),
      },
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });
});

describe('support message validation', () => {
  it('strips header breaks from the subject', () => {
    expect(
      parseSupportMessage({
        subject: 'Hello\nBcc: evil@example.com',
        body: 'Please help',
      }).subject,
    ).toBe('Hello Bcc: evil@example.com');
  });

  it('rejects an invalid replyTo', () => {
    expect(() =>
      parseSupportMessage({
        subject: 'Hi',
        body: 'Hello',
        replyTo: 'not-an-email',
      }),
    ).toThrow('replyTo must be a valid email address.');
  });

  it('parses a website contact and defaults the subject', () => {
    const parsed = parseWebsiteContact({
      name: '  Ada\nLovelace  ',
      email: 'ada@example.com',
      message: '  Hello there  ',
      extra: 'ignored',
    });
    expect(parsed.name).toBe('Ada Lovelace');
    expect(parsed.subject).toBe('Website contact from Ada Lovelace');
    expect(parsed.message).toBe('Hello there');
  });

  it('treats a blank company field as not a honeypot', () => {
    expect(isHoneypotTripped(undefined)).toBe(false);
    expect(isHoneypotTripped('')).toBe(false);
    expect(isHoneypotTripped('   ')).toBe(false);
    expect(isHoneypotTripped('bot')).toBe(true);
  });
});

describe('support contact origins', () => {
  it('parses a comma-separated allowlist', () => {
    expect(
      parseAllowedOrigins(
        'https://pocketcloset.app, https://*--pocket-closet.netlify.app',
      ),
    ).toEqual([
      'https://pocketcloset.app',
      'https://*--pocket-closet.netlify.app',
    ]);
  });

  it('allows curl (no Origin) even when the allowlist is empty', () => {
    expect(isOriginAllowed(undefined, [])).toBe(true);
  });

  it('rejects browser Origin when the allowlist is empty', () => {
    expect(isOriginAllowed('https://pocketcloset.app', [])).toBe(false);
  });

  it('rejects wildcard lookalikes that add extra labels or suffixes', () => {
    const allowlist = ['https://*--pocket-closet.netlify.app'];
    expect(
      isOriginAllowed(
        'https://deploy-preview-12--pocket-closet.netlify.app',
        allowlist,
      ),
    ).toBe(true);
    expect(
      isOriginAllowed(
        'https://evil--pocket-closet.netlify.app.attacker.com',
        allowlist,
      ),
    ).toBe(false);
    expect(
      isOriginAllowed('https://x.evil--pocket-closet.netlify.app', allowlist),
    ).toBe(false);
  });
});

describe('support contact rate limit', () => {
  it('hashes the IP and increments a windowed counter', async () => {
    const increment = jest.fn().mockResolvedValue(3);
    const nowMs = 1_700_000_000_000;

    const decision = await consumeContactRateLimit(
      '203.0.113.9',
      increment,
      nowMs,
    );

    expect(decision).toEqual({
      allowed: true,
      retryAfterSeconds: expect.any(Number),
      count: 3,
    });
    expect(increment).toHaveBeenCalledWith(
      expect.objectContaining({
        pk: `RATE#SUPPORT_CONTACT#${hashIp('203.0.113.9')}`,
        entityType: 'RATE_LIMIT',
      }),
    );
    expect(increment.mock.calls[0][0].pk).not.toContain('203.0.113.9');
    expect(increment.mock.calls[0][0].sk).toMatch(/^WINDOW#\d+$/);
  });

  it('returns not allowed once the counter exceeds the limit', async () => {
    const increment = jest.fn().mockResolvedValue(6);
    const decision = await consumeContactRateLimit('203.0.113.9', increment);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe('support secret parsing', () => {
  it('accepts a raw API key', () => {
    expect(parseSupportMailSecret('  re_plain  ')).toEqual({ apiKey: 're_plain' });
  });

  it('accepts the documented JSON shape', () => {
    expect(
      parseSupportMailSecret(
        JSON.stringify({
          apiKey: 're_json',
          webhookSecret: 'whsec_json',
          fromEmail: 'support@example.test',
          forwardTo: 'tunde@example.test',
        }),
      ),
    ).toEqual({
      apiKey: 're_json',
      webhookSecret: 'whsec_json',
      fromEmail: 'support@example.test',
      forwardTo: 'tunde@example.test',
    });
  });
});

describe('support mail formatting', () => {
  it('includes kind, user, and optional meta on outbound mail', () => {
    const formatted = formatOutboundMail({
      kind: 'bug',
      userId: 'uid-1',
      subject: 'Crash',
      body: 'It crashed.',
      meta: { platform: 'android' },
    });
    expect(formatted.subject).toBe('[Wardrobe Bug report] Crash');
    expect(formatted.text).toContain('Kind: bug');
    expect(formatted.text).toContain('User ID: uid-1');
    expect(formatted.text).toContain('platform: android');
  });

  it('tags website mail without a user id', () => {
    const formatted = formatOutboundMail({
      kind: 'contact',
      source: 'website',
      name: 'Ada',
      subject: 'Website contact from Ada',
      body: 'Hello',
      replyTo: 'ada@example.com',
    });
    expect(formatted.subject).toBe('[Website] Website contact from Ada');
    expect(formatted.text).toContain('Source: website');
    expect(formatted.text).toContain('Name: Ada');
    expect(formatted.text).not.toContain('User ID:');
  });

  it('falls back to a metadata notification when inbound body is missing', () => {
    const formatted = formatInboundForward({
      webhookFrom: 'user@example.com',
      webhookTo: ['support@example.test'],
      webhookSubject: 'Help',
    });
    expect(formatted.subject).toBe('Fwd: Help');
    expect(formatted.text).toContain('Body unavailable');
  });
});
