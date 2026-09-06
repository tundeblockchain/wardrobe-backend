import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { handleSupport } from '../../src/functions/support/handler';
import { parseSupportMailSecret } from '../../src/functions/support/config';
import {
  formatInboundForward,
  formatOutboundMail,
} from '../../src/functions/support/resend';
import { parseSupportMessage } from '../../src/functions/support/validation';

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
}): APIGatewayProxyEventV2 {
  const authorizer =
    options.sub === null
      ? undefined
      : {
          lambda: { sub: options.sub ?? 'firebase-uid-owner' },
        };

  return {
    version: '2.0',
    routeKey: `POST ${options.path}`,
    rawPath: options.path,
    rawQueryString: '',
    headers: { authorization: 'Bearer unused-in-handler' },
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
        sourceIp: '127.0.0.1',
        userAgent: 'jest',
      },
      requestId: 'req-1',
      routeKey: `POST ${options.path}`,
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
      authorizer,
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

describe('support outbound (WARDROBE-38)', () => {
  const sendEmail = jest.fn();
  const loadConfig = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    loadConfig.mockResolvedValue({
      apiKey: 're_test_key',
      webhookSecret: 'whsec_test',
      fromEmail: 'Wardrobe Support <support@example.test>',
      forwardTo: 'tunde@example.test',
    });
    sendEmail.mockResolvedValue({ id: 'email_123' });
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
        { loadConfig, sendEmail },
      ),
    );

    expect(result.statusCode).toBe(202);
    expect(bodyOf(result)).toEqual({
      status: 'sent',
      kind: 'contact',
      id: 'email_123',
    });
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
  });

  it('sends a bug report with the bug subject prefix', async () => {
    const result = asResult(
      await handleSupport(
        event({
          path: '/support/bug',
          body: { subject: 'Crash on save', body: 'Outfit save dies.' },
        }),
        { loadConfig, sendEmail },
      ),
    );

    expect(result.statusCode).toBe(202);
    expect(bodyOf(result)).toEqual({
      status: 'sent',
      kind: 'bug',
      id: 'email_123',
    });
    expect(sendEmail.mock.calls[0][0].subject).toBe(
      '[Wardrobe Bug report] Crash on save',
    );
  });

  it('rejects unauthenticated requests', async () => {
    const result = asResult(
      await handleSupport(
        event({
          path: '/support/contact',
          body: { subject: 'Hi', body: 'Hello' },
          sub: null,
        }),
        { loadConfig, sendEmail },
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

  it('rejects a missing subject', async () => {
    const result = asResult(
      await handleSupport(
        event({
          path: '/support/contact',
          body: { body: 'No subject' },
        }),
        { loadConfig, sendEmail },
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
        { loadConfig, sendEmail },
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
