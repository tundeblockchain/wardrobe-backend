import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { AiProfile, DynamoItem } from '../../src/shared/types';

const mockSend = jest.fn();
const mockS3Send = jest.fn();
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
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'PutObject',
    input,
  })),
  GetObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'GetObject',
    input,
  })),
  ListObjectsV2Command: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'ListObjectsV2',
    input,
  })),
  DeleteObjectsCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'DeleteObjects',
    input,
  })),
  DeleteObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'DeleteObject',
    input,
  })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

import { handler } from '../../src/functions/ai-profiles/handler';
import { buildGenericModelProfile } from '../../src/functions/ai-profiles/model';
import { answerEntitlement } from '../helpers/entitlements';

const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OWNER_ID = 'firebase-uid-owner';
const OTHER_ID = 'firebase-uid-other';
const PROFILE_ID = 'profile_abc123xy';
const GENERIC_ID = 'profile_model0001';
const PREFIX = `users/${OWNER_ID}/ai-profiles/${PROFILE_ID}/`;
const KEY_A = `${PREFIX}aaa.jpg`;
const KEY_B = `${PREFIX}bbb.jpg`;
const KEY_C = `${PREFIX}ccc.jpg`;
const KEY_D = `${PREFIX}ddd.jpg`;
const SIGNED_URL = 'https://signed.example/ref';

interface Command {
  _op: 'Put' | 'Get' | 'Query' | 'Update' | 'Delete';
  input: {
    TableName?: string;
    Item?: DynamoItem;
    Key?: { PK: string; SK: string };
    UpdateExpression?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
    ExpressionAttributeNames?: Record<string, string>;
  };
}

interface S3Command {
  _op: 'DeleteObject' | 'ListObjectsV2' | 'DeleteObjects';
  input: {
    Bucket?: string;
    Key?: string;
    Prefix?: string;
    Delete?: { Objects?: Array<{ Key: string }> };
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

function dynamoPersonal(overrides: Partial<DynamoItem> = {}): DynamoItem {
  return {
    PK: `USER#${OWNER_ID}`,
    SK: `AIPROFILE#${PROFILE_ID}`,
    entityType: 'AIPROFILE',
    userId: OWNER_ID,
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
    referenceImages: ['shared/ai-profiles/generic/alex/front.png'],
    status: 'READY',
    createdAt: '2026-09-06T07:00:00.000Z',
    updatedAt: '2026-09-06T07:00:00.000Z',
  });
}

function mockOwnedUpdate(item: DynamoItem): void {
  mockSend.mockImplementation(
    answerEntitlement(async (command: Command) => {
      if (command._op === 'Get') {
        if (command.input.Key?.PK === `USER#${OWNER_ID}`) {
          return { Item: item };
        }
        return {};
      }
      if (command._op === 'Update') {
        return {
          Attributes: {
            ...item,
            ...Object.fromEntries(
              Object.entries(command.input.ExpressionAttributeValues ?? {}).map(
                ([name, value]) => [name.slice(1), value],
              ),
            ),
          },
        };
      }
      if (command._op === 'Delete') {
        return {};
      }
      throw new Error(`unexpected op ${command._op}`);
    }),
  );
}

function mockGenericMutation(suffix: 'reference-images' | 'reference-images/main'): void {
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
    throw new Error(`unexpected op ${command._op} ${suffix}`);
  });
}

function event(options: {
  method: string;
  aiProfileId?: string;
  suffix?: 'reference-images' | 'reference-images/main';
  body?: unknown;
  sub?: string | null;
}): APIGatewayProxyEventV2 {
  const authorizer =
    options.sub === null
      ? undefined
      : {
          lambda: { sub: options.sub ?? OWNER_ID },
        };

  const suffix = options.suffix ? `/${options.suffix}` : '';
  const path = options.aiProfileId
    ? `/ai-profiles/${options.aiProfileId}${suffix}`
    : '/ai-profiles';
  const route = options.aiProfileId
    ? `${options.method} /ai-profiles/{aiProfileId}${suffix}`
    : `${options.method} /ai-profiles`;

  return {
    version: '2.0',
    routeKey: route,
    rawPath: path,
    rawQueryString: '',
    headers: { authorization: 'Bearer unused-in-handler' },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
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

function updateCommand(): Command {
  return mockSend.mock.calls.find(
    (call) => (call[0] as Command)._op === 'Update',
  )?.[0] as Command;
}

describe('Virtual Profile main photo (WARDROBE-157)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
    process.env.MEDIA_BUCKET_NAME = 'wardrobe-media-test';
    mockGetSignedUrl.mockResolvedValue(SIGNED_URL);
    mockS3Send.mockResolvedValue({ Contents: [], IsTruncated: false });
  });

  afterEach(() => {
    delete process.env.TABLE_NAME;
    delete process.env.MEDIA_BUCKET_NAME;
  });

  describe('POST /ai-profiles/{id}/reference-images setAsMain / replaceMain', () => {
    it('defaults setAsMain true when the gallery is empty', async () => {
      mockOwnedUpdate(dynamoPersonal());

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images',
            body: { objectKey: KEY_A, userId: OTHER_ID },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect((bodyOf(result) as AiProfile).mainImageKey).toBe(KEY_A);
      expect(updateCommand().input.ExpressionAttributeValues).toEqual(
        expect.objectContaining({
          ':referenceImages': [KEY_A],
          ':mainImageKey': KEY_A,
        }),
      );
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('defaults setAsMain false and backfills the existing frontal key', async () => {
      mockOwnedUpdate(dynamoPersonal({ referenceImages: [KEY_A] }));

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images',
            body: { objectKey: KEY_B },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(updateCommand().input.ExpressionAttributeValues).toEqual(
        expect.objectContaining({
          ':referenceImages': [KEY_A, KEY_B],
          ':mainImageKey': KEY_A,
        }),
      );
      expect((bodyOf(result) as AiProfile).mainImageKey).toBe(KEY_A);
    });

    it('sets the incoming key as main when setAsMain is true', async () => {
      mockOwnedUpdate(
        dynamoPersonal({
          referenceImages: [KEY_A],
          mainImageKey: KEY_A,
        }),
      );

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images',
            body: { objectKey: KEY_B, setAsMain: true },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(updateCommand().input.ExpressionAttributeValues).toEqual(
        expect.objectContaining({
          ':referenceImages': [KEY_A, KEY_B],
          ':mainImageKey': KEY_B,
        }),
      );
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('rejects replaceMain without setAsMain', async () => {
      mockOwnedUpdate(
        dynamoPersonal({
          referenceImages: [KEY_A],
          mainImageKey: KEY_A,
        }),
      );

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images',
            body: { objectKey: KEY_B, replaceMain: true },
          }),
        ),
      );

      expectEnvelope(result, 400, 'VALIDATION_ERROR');
      expect(updateCommand()).toBeUndefined();
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('replaces the previous main after a successful Dynamo write', async () => {
      mockOwnedUpdate(
        dynamoPersonal({
          referenceImages: [KEY_A, KEY_C],
          mainImageKey: KEY_A,
        }),
      );

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images',
            body: { objectKey: KEY_B, setAsMain: true, replaceMain: true },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(updateCommand().input.ExpressionAttributeValues).toEqual(
        expect.objectContaining({
          ':referenceImages': [KEY_C, KEY_B],
          ':mainImageKey': KEY_B,
        }),
      );
      expect(mockS3Send).toHaveBeenCalledWith(
        expect.objectContaining({
          _op: 'DeleteObject',
          input: { Bucket: 'wardrobe-media-test', Key: KEY_A },
        }),
      );
    });

    it('does not delete the old main S3 object when attach never succeeds', async () => {
      mockOwnedUpdate(
        dynamoPersonal({
          referenceImages: [KEY_A],
          mainImageKey: KEY_A,
        }),
      );

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images',
            body: {
              objectKey: `users/${OWNER_ID}/uploads/not-this.jpg`,
              setAsMain: true,
              replaceMain: true,
            },
          }),
        ),
      );

      expectEnvelope(result, 400, 'VALIDATION_ERROR');
      expect(updateCommand()).toBeUndefined();
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('allows replaceMain when the gallery is already at 10 photos', async () => {
      const filled = Array.from(
        { length: 10 },
        (_, index) => `${PREFIX}slot-${index}.jpg`,
      );
      mockOwnedUpdate(
        dynamoPersonal({
          referenceImages: filled,
          mainImageKey: filled[0],
        }),
      );

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images',
            body: { objectKey: KEY_D, setAsMain: true, replaceMain: true },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(
        updateCommand().input.ExpressionAttributeValues?.[':referenceImages'],
      ).toEqual([...filled.slice(1), KEY_D]);
      expect(
        updateCommand().input.ExpressionAttributeValues?.[':mainImageKey'],
      ).toBe(KEY_D);
    });
  });

  describe('PATCH /ai-profiles/{id}/reference-images/main', () => {
    it('sets mainImageKey to an existing gallery key without S3 writes', async () => {
      mockOwnedUpdate(
        dynamoPersonal({
          referenceImages: [KEY_A, KEY_B],
          mainImageKey: KEY_A,
        }),
      );

      const result = asResult(
        await handler(
          event({
            method: 'PATCH',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images/main',
            body: { objectKey: KEY_B, userId: OTHER_ID },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect((bodyOf(result) as AiProfile).mainImageKey).toBe(KEY_B);
      expect((bodyOf(result) as AiProfile).updatedAt).toMatch(ISO8601);
      expect(updateCommand().input.ExpressionAttributeValues).toEqual(
        expect.objectContaining({ ':mainImageKey': KEY_B }),
      );
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('rejects a key that is not already in referenceImages', async () => {
      mockOwnedUpdate(
        dynamoPersonal({
          referenceImages: [KEY_A],
          mainImageKey: KEY_A,
        }),
      );

      const result = asResult(
        await handler(
          event({
            method: 'PATCH',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images/main',
            body: { objectKey: KEY_B },
          }),
        ),
      );

      expectEnvelope(result, 400, 'VALIDATION_ERROR');
      expect(updateCommand()).toBeUndefined();
    });

    it('returns 403 for GENERIC_MODEL', async () => {
      mockGenericMutation('reference-images/main');

      const result = asResult(
        await handler(
          event({
            method: 'PATCH',
            aiProfileId: GENERIC_ID,
            suffix: 'reference-images/main',
            body: { objectKey: 'shared/ai-profiles/generic/alex/front.png' },
          }),
        ),
      );

      expectEnvelope(result, 403, 'UNAUTHORIZED');
    });

    it('returns 401 and ignores body userId when unauthenticated', async () => {
      const result = asResult(
        await handler(
          event({
            method: 'PATCH',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images/main',
            body: { objectKey: KEY_A, userId: OWNER_ID },
            sub: null,
          }),
        ),
      );

      expectEnvelope(result, 401, 'UNAUTHENTICATED');
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /ai-profiles/{id}/reference-images', () => {
    it('removes a non-main photo and best-effort deletes S3', async () => {
      mockOwnedUpdate(
        dynamoPersonal({
          referenceImages: [KEY_A, KEY_B],
          mainImageKey: KEY_A,
        }),
      );

      const result = asResult(
        await handler(
          event({
            method: 'DELETE',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images',
            body: { objectKey: KEY_B, userId: OTHER_ID },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(updateCommand().input.ExpressionAttributeValues).toEqual(
        expect.objectContaining({
          ':referenceImages': [KEY_A],
          ':mainImageKey': KEY_A,
        }),
      );
      expect(mockS3Send).toHaveBeenCalledWith(
        expect.objectContaining({
          _op: 'DeleteObject',
          input: { Bucket: 'wardrobe-media-test', Key: KEY_B },
        }),
      );
    });

    it('auto-promotes the remaining photo when deleting main with one other', async () => {
      mockOwnedUpdate(
        dynamoPersonal({
          referenceImages: [KEY_A, KEY_B],
          mainImageKey: KEY_A,
        }),
      );

      const result = asResult(
        await handler(
          event({
            method: 'DELETE',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images',
            body: { objectKey: KEY_A },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(updateCommand().input.ExpressionAttributeValues).toEqual(
        expect.objectContaining({
          ':referenceImages': [KEY_B],
          ':mainImageKey': KEY_B,
        }),
      );
    });

    it('requires promoteObjectKey when deleting main with two or more others', async () => {
      mockOwnedUpdate(
        dynamoPersonal({
          referenceImages: [KEY_A, KEY_B, KEY_C],
          mainImageKey: KEY_A,
        }),
      );

      const missing = asResult(
        await handler(
          event({
            method: 'DELETE',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images',
            body: { objectKey: KEY_A },
          }),
        ),
      );
      expectEnvelope(missing, 400, 'MAIN_IMAGE_REQUIRED');
      expect(updateCommand()).toBeUndefined();
      expect(mockS3Send).not.toHaveBeenCalled();

      const promoted = asResult(
        await handler(
          event({
            method: 'DELETE',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images',
            body: { objectKey: KEY_A, promoteObjectKey: KEY_C },
          }),
        ),
      );
      expect(promoted.statusCode).toBe(200);
      expect(updateCommand().input.ExpressionAttributeValues).toEqual(
        expect.objectContaining({
          ':referenceImages': [KEY_B, KEY_C],
          ':mainImageKey': KEY_C,
        }),
      );
    });

    it('rejects promoteObjectKey that is not a remaining gallery key', async () => {
      mockOwnedUpdate(
        dynamoPersonal({
          referenceImages: [KEY_A, KEY_B, KEY_C],
          mainImageKey: KEY_A,
        }),
      );

      const result = asResult(
        await handler(
          event({
            method: 'DELETE',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images',
            body: { objectKey: KEY_A, promoteObjectKey: KEY_A },
          }),
        ),
      );

      expectEnvelope(result, 400, 'VALIDATION_ERROR');
    });

    it('clears mainImageKey when deleting the last photo', async () => {
      mockOwnedUpdate(
        dynamoPersonal({
          referenceImages: [KEY_A],
          mainImageKey: KEY_A,
        }),
      );

      const result = asResult(
        await handler(
          event({
            method: 'DELETE',
            aiProfileId: PROFILE_ID,
            suffix: 'reference-images',
            body: { objectKey: KEY_A },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(updateCommand().input.UpdateExpression).toContain('REMOVE');
      expect(updateCommand().input.ExpressionAttributeNames).toEqual(
        expect.objectContaining({ '#mainImageKey': 'mainImageKey' }),
      );
      expect(
        updateCommand().input.ExpressionAttributeValues?.[':referenceImages'],
      ).toEqual([]);
      expect((bodyOf(result) as AiProfile)).not.toHaveProperty('mainImageKey');
    });

    it('returns 403 for GENERIC_MODEL', async () => {
      mockGenericMutation('reference-images');

      const result = asResult(
        await handler(
          event({
            method: 'DELETE',
            aiProfileId: GENERIC_ID,
            suffix: 'reference-images',
            body: { objectKey: 'shared/ai-profiles/generic/alex/front.png' },
          }),
        ),
      );

      expectEnvelope(result, 403, 'UNAUTHORIZED');
    });
  });

  describe('backfill and profile delete', () => {
    it('persists resolved mainImageKey on the next body PATCH', async () => {
      mockOwnedUpdate(dynamoPersonal({ referenceImages: [KEY_B, KEY_A] }));

      const result = asResult(
        await handler(
          event({
            method: 'PATCH',
            aiProfileId: PROFILE_ID,
            body: { heightCm: 170 },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(updateCommand().input.ExpressionAttributeValues).toEqual(
        expect.objectContaining({
          ':heightCm': 170,
          ':mainImageKey': KEY_B,
        }),
      );
    });

    it('best-effort deletes S3 objects under the profile prefix on DELETE profile', async () => {
      mockOwnedUpdate(
        dynamoPersonal({
          referenceImages: [KEY_A],
          mainImageKey: KEY_A,
        }),
      );
      mockS3Send
        .mockResolvedValueOnce({
          Contents: [{ Key: KEY_A }, { Key: `${PREFIX}orphan.jpg` }],
          IsTruncated: false,
        })
        .mockResolvedValueOnce({
          Deleted: [{ Key: KEY_A }, { Key: `${PREFIX}orphan.jpg` }],
        });

      const result = asResult(
        await handler(
          event({ method: 'DELETE', aiProfileId: PROFILE_ID }),
        ),
      );

      expect(result.statusCode).toBe(204);
      const dynamoDelete = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Delete',
      )?.[0] as Command;
      expect(dynamoDelete.input.Key).toEqual({
        PK: `USER#${OWNER_ID}`,
        SK: `AIPROFILE#${PROFILE_ID}`,
      });
      expect(mockS3Send).toHaveBeenCalledWith(
        expect.objectContaining({
          _op: 'ListObjectsV2',
          input: expect.objectContaining({
            Bucket: 'wardrobe-media-test',
            Prefix: PREFIX,
          }),
        }),
      );
      expect(mockS3Send).toHaveBeenCalledWith(
        expect.objectContaining({
          _op: 'DeleteObjects',
          input: {
            Bucket: 'wardrobe-media-test',
            Delete: {
              Objects: [{ Key: KEY_A }, { Key: `${PREFIX}orphan.jpg` }],
              Quiet: false,
            },
          },
        }),
      );
    });
  });
});
