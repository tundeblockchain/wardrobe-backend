import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { MAX_UPLOAD_BYTES, PRESIGNED_URL_EXPIRES_IN } from '../../src/shared/s3';

const mockGetSignedUrl = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({})),
  PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'PutObject',
    input,
  })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { handler } from '../../src/functions/uploads/handler';

const OWNER_ID = 'firebase-uid-owner';
const OTHER_ID = 'firebase-uid-attacker';
const SIGNED_URL =
  'https://wardrobe-media-test.s3.amazonaws.com/users/firebase-uid-owner/uploads/abc.jpg?X-Amz-Signature=test';

interface PutCommand {
  _op: 'PutObject';
  input: {
    Bucket?: string;
    Key?: string;
    ContentType?: string;
    ContentLength?: number;
  };
}

function asResult(
  result: Awaited<ReturnType<typeof handler>>,
): APIGatewayProxyStructuredResultV2 {
  if (typeof result === 'string') {
    throw new Error('expected a structured API Gateway result');
  }
  return result;
}

function bodyOf(result: APIGatewayProxyStructuredResultV2): unknown {
  return result.body ? JSON.parse(result.body) : undefined;
}

function expectEnvelope(
  result: APIGatewayProxyStructuredResultV2,
  statusCode: number,
  code: string,
): void {
  expect(result.statusCode).toBe(statusCode);
  expect(bodyOf(result)).toEqual({
    error: {
      code,
      message: expect.any(String),
    },
  });
}

function event(options: {
  body?: unknown;
  rawBody?: string;
  sub?: string | null;
}): APIGatewayProxyEventV2 {
  const authorizer =
    options.sub === null
      ? undefined
      : {
          lambda: { sub: options.sub ?? OWNER_ID },
        };

  return {
    version: '2.0',
    routeKey: 'POST /uploads',
    rawPath: '/uploads',
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
        method: 'POST',
        path: '/uploads',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'jest',
      },
      requestId: 'req-1',
      routeKey: 'POST /uploads',
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
      authorizer,
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

describe('uploads handler (WARDROBE-8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MEDIA_BUCKET_NAME = 'wardrobe-media-test';
    mockGetSignedUrl.mockResolvedValue(SIGNED_URL);
  });

  afterEach(() => {
    delete process.env.MEDIA_BUCKET_NAME;
  });

  it('returns a Flutter UploadTicket with a key under users/{uid}/uploads/', async () => {
    const result = asResult(
      await handler(
        event({
          body: { contentType: 'image/jpeg', purpose: 'WARDROBE_ITEM' },
        }),
      ),
    );

    expect(result.statusCode).toBe(201);
    expect(bodyOf(result)).toEqual({
      uploadUrl: SIGNED_URL,
      objectKey: expect.stringMatching(
        new RegExp(`^users/${OWNER_ID}/uploads/[A-Za-z0-9_-]{16}\\.jpg$`),
      ),
      expiresIn: PRESIGNED_URL_EXPIRES_IN,
    });

    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    const [, command, options] = mockGetSignedUrl.mock.calls[0] as [
      unknown,
      PutCommand,
      { expiresIn: number },
    ];
    expect(command._op).toBe('PutObject');
    expect(command.input).toEqual({
      Bucket: 'wardrobe-media-test',
      Key: expect.stringMatching(
        new RegExp(`^users/${OWNER_ID}/uploads/[A-Za-z0-9_-]{16}\\.jpg$`),
      ),
      ContentType: 'image/jpeg',
    });
    expect(command.input.ContentLength).toBeUndefined();
    expect(options).toEqual({ expiresIn: PRESIGNED_URL_EXPIRES_IN });
    expect(PutObjectCommand).toHaveBeenCalled();
  });

  it('ignores body userId and keys the object to the token UID', async () => {
    const result = asResult(
      await handler(
        event({
          body: {
            contentType: 'image/png',
            purpose: 'WARDROBE_ITEM',
            userId: OTHER_ID,
          },
        }),
      ),
    );

    expect(result.statusCode).toBe(201);
    const body = bodyOf(result) as { objectKey: string };
    expect(body.objectKey).toMatch(
      new RegExp(`^users/${OWNER_ID}/uploads/[A-Za-z0-9_-]{16}\\.png$`),
    );
    expect(body.objectKey).not.toContain(OTHER_ID);

    const command = mockGetSignedUrl.mock.calls[0][1] as PutCommand;
    expect(command.input.Key).toMatch(
      new RegExp(`^users/${OWNER_ID}/uploads/`),
    );
  });

  it('normalizes contentType case and maps allowed types to extensions', async () => {
    const cases: Array<{ contentType: string; ext: string }> = [
      { contentType: 'IMAGE/JPEG', ext: 'jpg' },
      { contentType: 'image/png', ext: 'png' },
      { contentType: 'image/webp', ext: 'webp' },
      { contentType: 'image/heic', ext: 'heic' },
    ];

    for (const { contentType, ext } of cases) {
      mockGetSignedUrl.mockClear();
      const result = asResult(
        await handler(
          event({ body: { contentType, purpose: 'WARDROBE_ITEM' } }),
        ),
      );
      const body = bodyOf(result) as { objectKey: string };
      expect(result.statusCode).toBe(201);
      expect(body.objectKey.endsWith(`.${ext}`)).toBe(true);
      const command = mockGetSignedUrl.mock.calls[0][1] as PutCommand;
      expect(command.input.ContentType).toBe(contentType.toLowerCase());
    }
  });

  it('signs ContentLength when the client declares a size within the 10MB limit', async () => {
    const result = asResult(
      await handler(
        event({
          body: {
            contentType: 'image/jpeg',
            purpose: 'WARDROBE_ITEM',
            contentLength: 2048,
          },
        }),
      ),
    );

    expect(result.statusCode).toBe(201);
    const command = mockGetSignedUrl.mock.calls[0][1] as PutCommand;
    expect(command.input.ContentLength).toBe(2048);
  });

  it('returns 401 UNAUTHENTICATED without an authorizer identity', async () => {
    const result = asResult(
      await handler(
        event({
          sub: null,
          body: { contentType: 'image/jpeg', purpose: 'WARDROBE_ITEM' },
        }),
      ),
    );

    expectEnvelope(result, 401, 'UNAUTHENTICATED');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('returns 400 UPLOAD_INVALID for an unsupported contentType', async () => {
    const result = asResult(
      await handler(
        event({
          body: { contentType: 'application/pdf', purpose: 'WARDROBE_ITEM' },
        }),
      ),
    );

    expectEnvelope(result, 400, 'UPLOAD_INVALID');
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'UPLOAD_INVALID',
        message:
          'Unsupported content type. Use image/jpeg, image/png, image/webp, or image/heic.',
      },
    });
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('returns 400 UPLOAD_INVALID for an unsupported purpose', async () => {
    const result = asResult(
      await handler(
        event({
          body: { contentType: 'image/jpeg', purpose: 'AI_PROFILE' },
        }),
      ),
    );

    expectEnvelope(result, 400, 'UPLOAD_INVALID');
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'UPLOAD_INVALID',
        message: 'purpose must be WARDROBE_ITEM.',
      },
    });
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('returns 400 UPLOAD_INVALID when contentLength exceeds 10MB', async () => {
    const result = asResult(
      await handler(
        event({
          body: {
            contentType: 'image/jpeg',
            purpose: 'WARDROBE_ITEM',
            contentLength: MAX_UPLOAD_BYTES + 1,
          },
        }),
      ),
    );

    expectEnvelope(result, 400, 'UPLOAD_INVALID');
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'UPLOAD_INVALID',
        message: `Upload exceeds the ${MAX_UPLOAD_BYTES} byte (10MB) limit.`,
      },
    });
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('returns 400 UPLOAD_INVALID when contentLength is less than 1', async () => {
    const result = asResult(
      await handler(
        event({
          body: {
            contentType: 'image/jpeg',
            purpose: 'WARDROBE_ITEM',
            contentLength: 0,
          },
        }),
      ),
    );

    expectEnvelope(result, 400, 'UPLOAD_INVALID');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_ERROR for a missing contentType', async () => {
    const result = asResult(
      await handler(event({ body: { purpose: 'WARDROBE_ITEM' } })),
    );

    expectEnvelope(result, 400, 'VALIDATION_ERROR');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_ERROR when contentLength is not an integer', async () => {
    const result = asResult(
      await handler(
        event({
          body: {
            contentType: 'image/jpeg',
            purpose: 'WARDROBE_ITEM',
            contentLength: 1.5,
          },
        }),
      ),
    );

    expectEnvelope(result, 400, 'VALIDATION_ERROR');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_ERROR when the body is missing', async () => {
    const result = asResult(await handler(event({})));
    expectEnvelope(result, 400, 'VALIDATION_ERROR');
  });
});
