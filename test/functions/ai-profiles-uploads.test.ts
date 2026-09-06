import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { AiProfile, DynamoItem } from '../../src/shared/types';
import { MAX_UPLOAD_BYTES, PRESIGNED_URL_EXPIRES_IN } from '../../src/shared/s3';

const mockSend = jest.fn();
const mockGetSignedUrl = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockSend })),
  },
  PutCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Put',
    input,
  })),
  GetCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Get',
    input,
  })),
  QueryCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Query',
    input,
  })),
  UpdateCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Update',
    input,
  })),
  DeleteCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Delete',
    input,
  })),
}));

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

import { handler } from '../../src/functions/ai-profiles/handler';
import { buildGenericModelProfile } from '../../src/functions/ai-profiles/model';

const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OWNER_ID = 'firebase-uid-owner';
const OTHER_ID = 'firebase-uid-other';
const PROFILE_ID = 'profile_abc123xy';
const GENERIC_ID = 'profile_model0001';
const SIGNED_URL =
  'https://wardrobe-media-test.s3.amazonaws.com/users/firebase-uid-owner/ai-profiles/profile_abc123xy/abc.jpg?X-Amz-Signature=test';

interface Command {
  _op: 'Put' | 'Get' | 'Query' | 'Update' | 'Delete';
  input: {
    TableName?: string;
    Item?: DynamoItem;
    Key?: { PK: string; SK: string };
    UpdateExpression?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
  };
}

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

function dynamoPersonal(
  userId: string,
  overrides: Partial<DynamoItem> = {},
): DynamoItem {
  return {
    PK: `USER#${userId}`,
    SK: `AIPROFILE#${PROFILE_ID}`,
    entityType: 'AIPROFILE',
    userId,
    aiProfileId: PROFILE_ID,
    type: 'PERSONAL',
    referenceImages: [],
    status: 'READY',
    createdAt: '2026-09-06T08:00:00.000Z',
    updatedAt: '2026-09-06T08:00:00.000Z',
    ...overrides,
  };
}

function dynamoGeneric(): DynamoItem {
  return buildGenericModelProfile({
    aiProfileId: GENERIC_ID,
    referenceImages: ['models/generic/model-a.png'],
    status: 'READY',
    createdAt: '2026-09-06T07:00:00.000Z',
    updatedAt: '2026-09-06T07:00:00.000Z',
  });
}

function event(options: {
  method: string;
  aiProfileId?: string;
  suffix?: 'uploads' | 'reference-images';
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

  const suffix = options.suffix ? `/${options.suffix}` : '';
  const routeSuffix = options.suffix ? `/${options.suffix}` : '';
  const path = options.aiProfileId
    ? `/ai-profiles/${options.aiProfileId}${suffix}`
    : '/ai-profiles';
  const route = options.aiProfileId
    ? `${options.method} /ai-profiles/{aiProfileId}${routeSuffix}`
    : `${options.method} /ai-profiles`;

  return {
    version: '2.0',
    routeKey: route,
    rawPath: path,
    rawQueryString: '',
    headers: { authorization: 'Bearer unused-in-handler' },
    body:
      options.rawBody !== undefined
        ? options.rawBody
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined,
    pathParameters: options.aiProfileId
      ? { aiProfileId: options.aiProfileId }
      : undefined,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'example.com',
      domainPrefix: 'example',
      http: {
        method: options.method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'jest',
      },
      requestId: 'req-1',
      routeKey: route,
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
      authorizer,
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function expectFlutterDto(body: AiProfile): void {
  expect(body).not.toHaveProperty('userId');
  expect(body).not.toHaveProperty('PK');
  expect(body).not.toHaveProperty('SK');
  expect(body).not.toHaveProperty('GSI1PK');
  expect(body).not.toHaveProperty('GSI1SK');
  expect(body).not.toHaveProperty('entityType');
}

describe('ai-profiles reference-image upload (WARDROBE-44)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
    process.env.MEDIA_BUCKET_NAME = 'wardrobe-media-test';
    mockGetSignedUrl.mockResolvedValue(SIGNED_URL);
  });

  afterEach(() => {
    delete process.env.TABLE_NAME;
    delete process.env.MEDIA_BUCKET_NAME;
  });

  describe('POST /ai-profiles/{aiProfileId}/uploads', () => {
    it('returns an UploadTicket under users/{uid}/ai-profiles/{aiProfileId}/', async () => {
      mockSend.mockResolvedValue({ Item: dynamoPersonal(OWNER_ID) });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'uploads',
            body: { contentType: 'image/jpeg' },
          }),
        ),
      );

      expect(result.statusCode).toBe(201);
      expect(bodyOf(result)).toEqual({
        uploadUrl: SIGNED_URL,
        objectKey: expect.stringMatching(
          new RegExp(
            `^users/${OWNER_ID}/ai-profiles/${PROFILE_ID}/[A-Za-z0-9_-]{16}\\.jpg$`,
          ),
        ),
        expiresIn: PRESIGNED_URL_EXPIRES_IN,
      });

      const command = mockGetSignedUrl.mock.calls[0][1] as PutCommand;
      expect(command.input).toEqual({
        Bucket: 'wardrobe-media-test',
        Key: expect.stringMatching(
          new RegExp(`^users/${OWNER_ID}/ai-profiles/${PROFILE_ID}/`),
        ),
        ContentType: 'image/jpeg',
      });
    });

    it('ignores body userId and keys the object to the token UID', async () => {
      mockSend.mockResolvedValue({ Item: dynamoPersonal(OWNER_ID) });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'uploads',
            body: {
              contentType: 'image/png',
              purpose: 'AI_PROFILE_REFERENCE',
              userId: OTHER_ID,
            },
          }),
        ),
      );

      expect(result.statusCode).toBe(201);
      const body = bodyOf(result) as { objectKey: string };
      expect(body.objectKey).toMatch(
        new RegExp(`^users/${OWNER_ID}/ai-profiles/${PROFILE_ID}/`),
      );
      expect(body.objectKey).not.toContain(OTHER_ID);
    });

    it('signs ContentLength when declared within the 10MB limit', async () => {
      mockSend.mockResolvedValue({ Item: dynamoPersonal(OWNER_ID) });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'uploads',
            body: { contentType: 'image/webp', contentLength: 2048 },
          }),
        ),
      );

      expect(result.statusCode).toBe(201);
      const command = mockGetSignedUrl.mock.calls[0][1] as PutCommand;
      expect(command.input.ContentType).toBe('image/webp');
      expect(command.input.ContentLength).toBe(2048);
      expect((bodyOf(result) as { objectKey: string }).objectKey.endsWith('.webp')).toBe(
        true,
      );
    });

    it('returns 400 UPLOAD_INVALID for an unsupported contentType', async () => {
      mockSend.mockResolvedValue({ Item: dynamoPersonal(OWNER_ID) });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'uploads',
            body: { contentType: 'application/pdf' },
          }),
        ),
      );

      expectEnvelope(result, 400, 'UPLOAD_INVALID');
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });

    it('returns 400 UPLOAD_INVALID when purpose is not AI_PROFILE_REFERENCE', async () => {
      mockSend.mockResolvedValue({ Item: dynamoPersonal(OWNER_ID) });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'uploads',
            body: { contentType: 'image/jpeg', purpose: 'WARDROBE_ITEM' },
          }),
        ),
      );

      expectEnvelope(result, 400, 'UPLOAD_INVALID');
      expect(bodyOf(result)).toEqual({
        error: {
          code: 'UPLOAD_INVALID',
          message: 'purpose must be AI_PROFILE_REFERENCE.',
        },
      });
    });

    it('returns 400 UPLOAD_INVALID when contentLength exceeds 10MB', async () => {
      mockSend.mockResolvedValue({ Item: dynamoPersonal(OWNER_ID) });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'uploads',
            body: {
              contentType: 'image/jpeg',
              contentLength: MAX_UPLOAD_BYTES + 1,
            },
          }),
        ),
      );

      expectEnvelope(result, 400, 'UPLOAD_INVALID');
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });

    it('returns 404 when the PERSONAL profile belongs to another user', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'uploads',
            body: { contentType: 'image/jpeg' },
            sub: OTHER_ID,
          }),
        ),
      );

      expectEnvelope(result, 404, 'AI_PROFILE_NOT_FOUND');
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
      const first = mockSend.mock.calls[0][0] as Command;
      expect(first.input.Key?.PK).toBe(`USER#${OTHER_ID}`);
    });

    it('returns 403 when uploading to a GENERIC_MODEL profile', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.PK === `USER#${OWNER_ID}`) {
          return {};
        }
        if (
          command._op === 'Get' &&
          command.input.Key?.PK === 'AIPROFILE#GENERIC_MODEL'
        ) {
          return { Item: dynamoGeneric() };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: GENERIC_ID,
            suffix: 'uploads',
            body: { contentType: 'image/jpeg' },
          }),
        ),
      );

      expectEnvelope(result, 403, 'UNAUTHORIZED');
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });

    it('returns 401 UNAUTHENTICATED without an authorizer identity', async () => {
      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'uploads',
            body: { contentType: 'image/jpeg', userId: OWNER_ID },
            sub: null,
          }),
        ),
      );

      expectEnvelope(result, 401, 'UNAUTHENTICATED');
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });
  });

  describe('POST /ai-profiles/{aiProfileId}/reference-images', () => {
    const ownedKey = `users/${OWNER_ID}/ai-profiles/${PROFILE_ID}/ref1.jpg`;

    it('appends confirmed keys, sets READY, and returns the Flutter DTO', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
          return { Item: dynamoPersonal(OWNER_ID) };
        }
        if (command._op === 'Update') {
          return {
            Attributes: {
              ...dynamoPersonal(OWNER_ID),
              referenceImages: command.input.ExpressionAttributeValues?.[
                ':referenceImages'
              ],
              status: command.input.ExpressionAttributeValues?.[':status'],
              updatedAt: command.input.ExpressionAttributeValues?.[':updatedAt'],
            },
          };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images',
            body: { objectKey: ownedKey, userId: OTHER_ID },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      const body = bodyOf(result) as AiProfile;
      expect(body).toEqual({
        aiProfileId: PROFILE_ID,
        type: 'PERSONAL',
        referenceImages: [ownedKey],
        status: 'READY',
        createdAt: '2026-09-06T08:00:00.000Z',
        updatedAt: expect.stringMatching(ISO8601),
      });
      expectFlutterDto(body);

      const update = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Update',
      )?.[0] as Command;
      expect(update.input.Key).toEqual({
        PK: `USER#${OWNER_ID}`,
        SK: `AIPROFILE#${PROFILE_ID}`,
      });
      expect(update.input.ExpressionAttributeValues).toEqual(
        expect.objectContaining({
          ':referenceImages': [ownedKey],
          ':status': 'READY',
        }),
      );
    });

    it('accepts objectKeys and keeps existing images', async () => {
      const existing = `users/${OWNER_ID}/ai-profiles/${PROFILE_ID}/old.jpg`;
      const incoming = `users/${OWNER_ID}/ai-profiles/${PROFILE_ID}/new.png`;

      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
          return {
            Item: dynamoPersonal(OWNER_ID, { referenceImages: [existing] }),
          };
        }
        if (command._op === 'Update') {
          return {
            Attributes: dynamoPersonal(OWNER_ID, {
              referenceImages: [existing, incoming],
              status: 'READY',
            }),
          };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images',
            body: { objectKeys: [incoming] },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect((bodyOf(result) as AiProfile).referenceImages).toEqual([
        existing,
        incoming,
      ]);
      const update = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Update',
      )?.[0] as Command;
      expect(update.input.ExpressionAttributeValues?.[':referenceImages']).toEqual([
        existing,
        incoming,
      ]);
    });

    it('rejects a key that is not under this profile prefix', async () => {
      mockSend.mockResolvedValue({ Item: dynamoPersonal(OWNER_ID) });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images',
            body: { objectKey: `users/${OWNER_ID}/uploads/item.jpg` },
          }),
        ),
      );

      expectEnvelope(result, 400, 'VALIDATION_ERROR');
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Update'),
      ).toBe(false);
    });

    it('rejects another user objectKey', async () => {
      mockSend.mockResolvedValue({ Item: dynamoPersonal(OWNER_ID) });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images',
            body: {
              objectKey: `users/${OTHER_ID}/ai-profiles/${PROFILE_ID}/x.jpg`,
            },
          }),
        ),
      );

      expect(result.statusCode).toBe(400);
      expect(bodyOf(result)).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'objectKeys[0] must belong to the authenticated user.',
        },
      });
    });

    it('returns 404 when attaching to another user PERSONAL profile', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images',
            body: { objectKey: ownedKey },
            sub: OTHER_ID,
          }),
        ),
      );

      expectEnvelope(result, 404, 'AI_PROFILE_NOT_FOUND');
    });

    it('returns 403 when attaching to a GENERIC_MODEL profile', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.PK === `USER#${OWNER_ID}`) {
          return {};
        }
        if (
          command._op === 'Get' &&
          command.input.Key?.PK === 'AIPROFILE#GENERIC_MODEL'
        ) {
          return { Item: dynamoGeneric() };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: GENERIC_ID,
            suffix: 'reference-images',
            body: {
              objectKey: `users/${OWNER_ID}/ai-profiles/${GENERIC_ID}/x.jpg`,
            },
          }),
        ),
      );

      expectEnvelope(result, 403, 'UNAUTHORIZED');
    });

    it('returns 401 and ignores body userId when unauthenticated', async () => {
      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images',
            body: { objectKey: ownedKey, userId: OWNER_ID },
            sub: null,
          }),
        ),
      );

      expectEnvelope(result, 401, 'UNAUTHENTICATED');
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
