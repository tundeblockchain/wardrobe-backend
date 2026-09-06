import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { handleInboundWebhook } from '../../src/functions/support/webhook';
import { signResendWebhook } from '../../src/functions/support/webhook-verify';

const SECRET = `whsec_${Buffer.from('unit-test-webhook-secret').toString('base64')}`;
const TIMESTAMP = '1710000000';
const ID = 'msg_inbound_1';
const EMAIL_ID = '56761188-7520-42d8-8898-ff6fc54ce618';

function asResult(
  result: Awaited<ReturnType<typeof handleInboundWebhook>>,
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
  isBase64Encoded?: boolean;
}): APIGatewayProxyEventV2 {
  const id = options.id ?? ID;
  const timestamp = options.timestamp ?? TIMESTAMP;
  const signature =
    options.signature ??
    signResendWebhook({
      payload: options.payload,
      id,
      timestamp,
      webhookSecret: SECRET,
    });

  return {
    version: '2.0',
    routeKey: 'POST /webhooks/resend',
    rawPath: '/webhooks/resend',
    rawQueryString: '',
    headers: options.omitHeaders
      ? {}
      : {
          'svix-id': id,
          'svix-timestamp': timestamp,
          'svix-signature': signature,
        },
    body: options.isBase64Encoded
      ? Buffer.from(options.payload, 'utf8').toString('base64')
      : options.payload,
    isBase64Encoded: Boolean(options.isBase64Encoded),
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'example.com',
      domainPrefix: 'example',
      http: {
        method: 'POST',
        path: '/webhooks/resend',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'svix',
      },
      requestId: 'req-webhook',
      routeKey: 'POST /webhooks/resend',
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
    },
  } as unknown as APIGatewayProxyEventV2;
}

describe('support inbound webhook (WARDROBE-38)', () => {
  const sendEmail = jest.fn();
  const fetchReceivedEmail = jest.fn();
  const loadConfig = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    loadConfig.mockResolvedValue({
      apiKey: 're_test_key',
      webhookSecret: SECRET,
      fromEmail: 'support@example.test',
      forwardTo: 'tunde@example.test',
    });
    sendEmail.mockResolvedValue({ id: 'fwd_1' });
    fetchReceivedEmail.mockResolvedValue({
      id: EMAIL_ID,
      from: 'user@example.com',
      to: ['support@example.test'],
      subject: 'Need help with my wardrobe',
      text: 'The app will not save outfits.',
      html: null,
      attachments: [{ filename: 'screenshot.png', content_type: 'image/png' }],
    });
  });

  it('verifies the signature, fetches the received mail, and forwards it', async () => {
    const payload = JSON.stringify({
      type: 'email.received',
      data: {
        email_id: EMAIL_ID,
        from: 'user@example.com',
        to: ['support@example.test'],
        subject: 'Need help with my wardrobe',
      },
    });

    const result = asResult(
      await handleInboundWebhook(webhookEvent({ payload }), {
        loadConfig,
        sendEmail,
        fetchReceivedEmail,
        nowSeconds: Number(TIMESTAMP),
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual({
      status: 'forwarded',
      emailId: EMAIL_ID,
    });
    expect(fetchReceivedEmail).toHaveBeenCalledWith('re_test_key', EMAIL_ID);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'support@example.test',
        to: 'tunde@example.test',
        subject: 'Fwd: Need help with my wardrobe',
        idempotencyKey: `inbound:${EMAIL_ID}`,
      }),
    );
    const sent = sendEmail.mock.calls[0][0] as { text: string };
    expect(sent.text).toContain('The app will not save outfits.');
    expect(sent.text).toContain('screenshot.png');
  });

  it('acks non-inbound events without sending', async () => {
    const payload = JSON.stringify({ type: 'email.sent', data: {} });
    const result = asResult(
      await handleInboundWebhook(webhookEvent({ payload }), {
        loadConfig,
        sendEmail,
        fetchReceivedEmail,
        nowSeconds: Number(TIMESTAMP),
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual({
      status: 'ignored',
      type: 'email.sent',
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('still notifies when the receiving fetch fails', async () => {
    fetchReceivedEmail.mockResolvedValue(undefined);
    const payload = JSON.stringify({
      type: 'email.received',
      data: {
        email_id: EMAIL_ID,
        from: 'user@example.com',
        to: ['support@example.test'],
        subject: 'Help',
      },
    });

    const result = asResult(
      await handleInboundWebhook(webhookEvent({ payload }), {
        loadConfig,
        sendEmail,
        fetchReceivedEmail,
        nowSeconds: Number(TIMESTAMP),
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].text).toContain('Body unavailable');
  });

  it('rejects a bad signature without calling Resend', async () => {
    const payload = JSON.stringify({
      type: 'email.received',
      data: { email_id: EMAIL_ID },
    });

    const result = asResult(
      await handleInboundWebhook(
        webhookEvent({ payload, signature: 'v1,AAAAAAAAAAAAAAAAAAAAAA==' }),
        {
          loadConfig,
          sendEmail,
          fetchReceivedEmail,
          nowSeconds: Number(TIMESTAMP),
        },
      ),
    );

    expect(result.statusCode).toBe(403);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid Resend webhook signature.',
      },
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(fetchReceivedEmail).not.toHaveBeenCalled();
  });

  it('rejects missing Svix headers', async () => {
    const payload = JSON.stringify({
      type: 'email.received',
      data: { email_id: EMAIL_ID },
    });

    const result = asResult(
      await handleInboundWebhook(webhookEvent({ payload, omitHeaders: true }), {
        loadConfig,
        sendEmail,
        fetchReceivedEmail,
        nowSeconds: Number(TIMESTAMP),
      }),
    );

    expect(result.statusCode).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('decodes a base64 API Gateway body before verifying', async () => {
    const payload = JSON.stringify({
      type: 'email.received',
      data: { email_id: EMAIL_ID, subject: 'Encoded' },
    });

    const result = asResult(
      await handleInboundWebhook(
        webhookEvent({ payload, isBase64Encoded: true }),
        {
          loadConfig,
          sendEmail,
          fetchReceivedEmail,
          nowSeconds: Number(TIMESTAMP),
        },
      ),
    );

    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual({
      status: 'forwarded',
      emailId: EMAIL_ID,
    });
  });
});
