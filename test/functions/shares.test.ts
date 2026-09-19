import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DynamoItem, Share, SharePreview } from '../../src/shared/types';

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

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({})),
  GetObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'GetObject',
    input,
  })),
  PutObjectCommand: jest.fn(),
  ListObjectsV2Command: jest.fn(),
  DeleteObjectsCommand: jest.fn(),
}));

import { handler } from '../../src/functions/shares/handler';
import { SHARE_TOKEN_PATTERN } from '../../src/functions/shares/model';

const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OWNER_ID = 'firebase-uid-owner';
const OTHER_ID = 'firebase-uid-other';
const WARDROBE_ID = 'wd_abc123xyz0';
const ITEM_ID = 'item_xyz123abcd';
const OUTFIT_ID = 'outfit_qwerty12';
const SHARE_TOKEN = 'shr_V1StGXR8_Z5jdHi6B-myT';
const IMAGE_URL = 'https://signed.example/preview.png';
const ORIGINAL_KEY = `users/${OWNER_ID}/uploads/photo.jpg`;
const PROCESSED_KEY = `users/${OWNER_ID}/items/${ITEM_ID}/processed.png`;
const RENDER_KEY = `users/${OWNER_ID}/outfits/${OUTFIT_ID}/renders/rend_abc.png`;

interface Command {
  _op: 'Put' | 'Get' | 'Query' | 'Update' | 'Delete';
  input: {
    TableName?: string;
    Item?: DynamoItem;
    Key?: { PK: string; SK: string };
    UpdateExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
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

function dynamoWardrobe(userId = OWNER_ID): DynamoItem {
  return {
    PK: `USER#${userId}`,
    SK: `WARDROBE#${WARDROBE_ID}`,
    entityType: 'WARDROBE',
    userId,
    wardrobeId: WARDROBE_ID,
    name: 'Summer Clothes',
    createdAt: '2026-09-03T18:35:00.000Z',
    updatedAt: '2026-09-03T18:35:00.000Z',
  };
}

function dynamoItem(overrides: Partial<DynamoItem> = {}): DynamoItem {
  return {
    PK: `WARDROBE#${WARDROBE_ID}`,
    SK: `ITEM#${ITEM_ID}`,
    entityType: 'ITEM',
    userId: OWNER_ID,
    wardrobeId: WARDROBE_ID,
    itemId: ITEM_ID,
    name: 'Black T-Shirt',
    category: 'TOP',
    originalKey: ORIGINAL_KEY,
    processedKey: PROCESSED_KEY,
    processingStatus: 'READY',
    createdAt: '2026-09-03T18:45:00.000Z',
    updatedAt: '2026-09-03T18:45:00.000Z',
    ...overrides,
  };
}

function dynamoOutfit(overrides: Partial<DynamoItem> = {}): DynamoItem {
  return {
    PK: `WARDROBE#${WARDROBE_ID}`,
    SK: `OUTFIT#${OUTFIT_ID}`,
    entityType: 'OUTFIT',
    userId: OWNER_ID,
    wardrobeId: WARDROBE_ID,
    outfitId: OUTFIT_ID,
    name: 'Friday Night',
    items: [{ itemId: ITEM_ID, slot: 'TOP' }],
    createdAt: '2026-09-03T18:50:00.000Z',
    updatedAt: '2026-09-03T18:50:00.000Z',
    ...overrides,
  };
}

function dynamoShare(overrides: Partial<DynamoItem> = {}): DynamoItem {
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  return {
    PK: `SHARE#${SHARE_TOKEN}`,
    SK: 'SHARE',
    GSI1PK: `SHARE#USER#${OWNER_ID}`,
    GSI1SK: `SHARE#${SHARE_TOKEN}`,
    entityType: 'SHARE',
    userId: OWNER_ID,
    wardrobeId: WARDROBE_ID,
    resourceType: 'ITEM',
    itemId: ITEM_ID,
    token: SHARE_TOKEN,
    expiresAt: future,
    createdAt: '2026-09-19T12:00:00.000Z',
    updatedAt: '2026-09-19T12:00:00.000Z',
    ttl: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    ...overrides,
  };
}

function event(options: {
  method: string;
  path: string;
  routeKey?: string;
  wardrobeId?: string;
  itemId?: string;
  outfitId?: string;
  token?: string;
  body?: unknown;
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
    routeKey: options.routeKey ?? `${options.method} ${options.path}`,
    rawPath: options.path,
    rawQueryString: '',
    headers: { authorization: 'Bearer unused-in-handler' },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    pathParameters: {
      ...(options.wardrobeId ? { wardrobeId: options.wardrobeId } : {}),
      ...(options.itemId ? { itemId: options.itemId } : {}),
      ...(options.outfitId ? { outfitId: options.outfitId } : {}),
      ...(options.token ? { token: options.token } : {}),
    },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'example.com',
      domainPrefix: 'example',
      http: {
        method: options.method,
        path: options.path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'jest',
      },
      requestId: 'req-1',
      routeKey: options.routeKey ?? `${options.method} ${options.path}`,
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
      authorizer,
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function itemShareEvent(
  overrides: Partial<Parameters<typeof event>[0]> = {},
): APIGatewayProxyEventV2 {
  return event({
    method: 'POST',
    path: `/wardrobes/${WARDROBE_ID}/items/${ITEM_ID}/share`,
    routeKey: 'POST /wardrobes/{wardrobeId}/items/{itemId}/share',
    wardrobeId: WARDROBE_ID,
    itemId: ITEM_ID,
    ...overrides,
  });
}

function outfitShareEvent(
  overrides: Partial<Parameters<typeof event>[0]> = {},
): APIGatewayProxyEventV2 {
  return event({
    method: 'POST',
    path: `/wardrobes/${WARDROBE_ID}/outfits/${OUTFIT_ID}/share`,
    routeKey: 'POST /wardrobes/{wardrobeId}/outfits/{outfitId}/share',
    wardrobeId: WARDROBE_ID,
    outfitId: OUTFIT_ID,
    ...overrides,
  });
}

function publicShareEvent(
  token = SHARE_TOKEN,
  overrides: Partial<Parameters<typeof event>[0]> = {},
): APIGatewayProxyEventV2 {
  return event({
    method: 'GET',
    path: `/public/shares/${token}`,
    routeKey: 'GET /public/shares/{token}',
    token,
    sub: null,
    ...overrides,
  });
}

function revokeEvent(
  token = SHARE_TOKEN,
  overrides: Partial<Parameters<typeof event>[0]> = {},
): APIGatewayProxyEventV2 {
  return event({
    method: 'DELETE',
    path: `/shares/${token}`,
    routeKey: 'DELETE /shares/{token}',
    token,
    ...overrides,
  });
}

function mockOwnedItemGets(): void {
  mockSend.mockImplementation(async (command: Command) => {
    if (command._op === 'Get') {
      const { PK, SK } = command.input.Key ?? { PK: '', SK: '' };
      if (PK === `USER#${OWNER_ID}` && SK === `WARDROBE#${WARDROBE_ID}`) {
        return { Item: dynamoWardrobe() };
      }
      if (PK === `WARDROBE#${WARDROBE_ID}` && SK === `ITEM#${ITEM_ID}`) {
        return { Item: dynamoItem() };
      }
      if (PK === `WARDROBE#${WARDROBE_ID}` && SK === `OUTFIT#${OUTFIT_ID}`) {
        return { Item: dynamoOutfit() };
      }
      return {};
    }
    if (command._op === 'Put' || command._op === 'Update') {
      return {};
    }
    throw new Error(`unexpected Dynamo op ${command._op}`);
  });
}

describe('shares handler (WARDROBE-126)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
    process.env.MEDIA_BUCKET_NAME = 'wardrobe-media-test';
    mockGetSignedUrl.mockResolvedValue(IMAGE_URL);
  });

  afterEach(() => {
    delete process.env.TABLE_NAME;
    delete process.env.MEDIA_BUCKET_NAME;
  });

  describe('POST item share', () => {
    it('creates a Share DTO for the owner without entitlement checks', async () => {
      mockOwnedItemGets();

      const result = asResult(await handler(itemShareEvent()));

      expect(result.statusCode).toBe(201);
      const body = bodyOf(result) as Share;
      expect(body.resourceType).toBe('ITEM');
      expect(body.wardrobeId).toBe(WARDROBE_ID);
      expect(body.itemId).toBe(ITEM_ID);
      expect(body).not.toHaveProperty('outfitId');
      expect(body.token).toMatch(SHARE_TOKEN_PATTERN);
      expect(body.sharePath).toBe(`/share/${body.token}`);
      expect(body.sharePath.startsWith('/share/')).toBe(true);
      expect(body.sharePath).not.toMatch(/^https?:\/\//);
      expect(body.expiresAt).toMatch(ISO8601);
      expect(body.createdAt).toMatch(ISO8601);
      expect(body).not.toHaveProperty('userId');
      expect(JSON.stringify(body)).not.toContain('null');
      expect(JSON.stringify(body)).not.toContain(OWNER_ID);

      const put = mockSend.mock.calls
        .map((call) => call[0] as Command)
        .find((command) => command._op === 'Put');
      expect(put?.input.Item?.PK).toBe(`SHARE#${body.token}`);
      expect(put?.input.Item?.SK).toBe('SHARE');
      expect(put?.input.Item?.GSI1PK).toBe(`SHARE#USER#${OWNER_ID}`);
      expect(put?.input.Item?.GSI1SK).toBe(`SHARE#${body.token}`);
      expect(put?.input.Item?.entityType).toBe('SHARE');
      expect(put?.input.Item?.ttl).toEqual(expect.any(Number));
      expect(put?.input.Item).not.toHaveProperty('outfitId');
    });

    it('issues a new token when create is called again', async () => {
      mockOwnedItemGets();

      const first = bodyOf(asResult(await handler(itemShareEvent()))) as Share;
      const second = bodyOf(asResult(await handler(itemShareEvent()))) as Share;

      expect(first.token).not.toBe(second.token);
      expect(first.token).toMatch(SHARE_TOKEN_PATTERN);
      expect(second.token).toMatch(SHARE_TOKEN_PATTERN);
    });

    it('returns 404 ITEM_NOT_FOUND for another user', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
          return {};
        }
        throw new Error(`unexpected Dynamo op ${command._op}`);
      });

      const result = asResult(await handler(itemShareEvent({ sub: OTHER_ID })));
      expectEnvelope(result, 404, 'WARDROBE_NOT_FOUND');
    });

    it('returns 401 without an authorizer', async () => {
      const result = asResult(await handler(itemShareEvent({ sub: null })));
      expectEnvelope(result, 401, 'UNAUTHENTICATED');
    });
  });

  describe('POST outfit share', () => {
    it('creates a Share DTO and soft-omits itemId', async () => {
      mockOwnedItemGets();

      const result = asResult(await handler(outfitShareEvent()));

      expect(result.statusCode).toBe(201);
      const body = bodyOf(result) as Share;
      expect(body.resourceType).toBe('OUTFIT');
      expect(body.outfitId).toBe(OUTFIT_ID);
      expect(body).not.toHaveProperty('itemId');
      expect(body.token).toMatch(SHARE_TOKEN_PATTERN);
      expect(JSON.stringify(body)).not.toContain('null');

      const put = mockSend.mock.calls
        .map((call) => call[0] as Command)
        .find((command) => command._op === 'Put');
      expect(put?.input.Item?.outfitId).toBe(OUTFIT_ID);
      expect(put?.input.Item).not.toHaveProperty('itemId');
    });

    it('returns 404 OUTFIT_NOT_FOUND when the outfit is missing', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
          const { PK, SK } = command.input.Key ?? { PK: '', SK: '' };
          if (PK === `USER#${OWNER_ID}` && SK === `WARDROBE#${WARDROBE_ID}`) {
            return { Item: dynamoWardrobe() };
          }
          return {};
        }
        throw new Error(`unexpected Dynamo op ${command._op}`);
      });

      const result = asResult(await handler(outfitShareEvent()));
      expectEnvelope(result, 404, 'OUTFIT_NOT_FOUND');
    });
  });

  describe('GET /public/shares/{token}', () => {
    it('returns a preview with a presigned image and no private fields', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
          const { PK, SK } = command.input.Key ?? { PK: '', SK: '' };
          if (PK === `SHARE#${SHARE_TOKEN}` && SK === 'SHARE') {
            return { Item: dynamoShare() };
          }
          if (PK === `WARDROBE#${WARDROBE_ID}` && SK === `ITEM#${ITEM_ID}`) {
            return { Item: dynamoItem() };
          }
          return {};
        }
        throw new Error(`unexpected Dynamo op ${command._op}`);
      });

      const result = asResult(await handler(publicShareEvent()));

      expect(result.statusCode).toBe(200);
      const body = bodyOf(result) as SharePreview;
      expect(body).toEqual({
        resourceType: 'ITEM',
        title: 'Black T-Shirt',
        imageUrl: IMAGE_URL,
        expiresAt: expect.stringMatching(ISO8601),
      });
      expect(body).not.toHaveProperty('userId');
      expect(body).not.toHaveProperty('token');
      expect(body).not.toHaveProperty('wardrobeId');
      expect(body).not.toHaveProperty('itemId');
      expect(JSON.stringify(body)).not.toContain(OWNER_ID);
      expect(JSON.stringify(body)).not.toContain('null');
      expect(mockGetSignedUrl).toHaveBeenCalled();
    });

    it('prefers a READY outfit render image over garment photos', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
          const { PK, SK } = command.input.Key ?? { PK: '', SK: '' };
          if (PK === `SHARE#${SHARE_TOKEN}` && SK === 'SHARE') {
            return {
              Item: dynamoShare({
                resourceType: 'OUTFIT',
                outfitId: OUTFIT_ID,
                itemId: undefined,
              }),
            };
          }
          if (PK === `WARDROBE#${WARDROBE_ID}` && SK === `OUTFIT#${OUTFIT_ID}`) {
            return {
              Item: dynamoOutfit({
                render: { status: 'READY', imageKey: RENDER_KEY, aiProfileId: 'p1' },
              }),
            };
          }
          return {};
        }
        throw new Error(`unexpected Dynamo op ${command._op}`);
      });

      const result = asResult(await handler(publicShareEvent()));
      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({
        resourceType: 'OUTFIT',
        title: 'Friday Night',
        imageUrl: IMAGE_URL,
        expiresAt: expect.stringMatching(ISO8601),
      });
    });

    it('soft-omits imageUrl when presign fails', async () => {
      mockGetSignedUrl.mockRejectedValue(new Error('kms denied'));
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
          const { PK, SK } = command.input.Key ?? { PK: '', SK: '' };
          if (PK === `SHARE#${SHARE_TOKEN}` && SK === 'SHARE') {
            return { Item: dynamoShare() };
          }
          if (PK === `WARDROBE#${WARDROBE_ID}` && SK === `ITEM#${ITEM_ID}`) {
            return { Item: dynamoItem() };
          }
          return {};
        }
        throw new Error(`unexpected Dynamo op ${command._op}`);
      });

      const result = asResult(await handler(publicShareEvent()));
      expect(result.statusCode).toBe(200);
      const body = bodyOf(result) as SharePreview;
      expect(body.title).toBe('Black T-Shirt');
      expect(body).not.toHaveProperty('imageUrl');
      expect(JSON.stringify(body)).not.toContain('null');
    });

    it('returns 404 SHARE_NOT_FOUND for a missing or invalid token', async () => {
      mockSend.mockResolvedValue({});

      expectEnvelope(
        asResult(await handler(publicShareEvent('not-a-token'))),
        404,
        'SHARE_NOT_FOUND',
      );
      expectEnvelope(
        asResult(await handler(publicShareEvent())),
        404,
        'SHARE_NOT_FOUND',
      );
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('returns 410 SHARE_GONE when expired or revoked', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
          return {
            Item: dynamoShare({
              expiresAt: '2020-01-01T00:00:00.000Z',
              ttl: 1,
            }),
          };
        }
        return {};
      });
      expectEnvelope(
        asResult(await handler(publicShareEvent())),
        410,
        'SHARE_GONE',
      );

      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
          return { Item: dynamoShare({ revokedAt: '2026-09-19T13:00:00.000Z' }) };
        }
        return {};
      });
      expectEnvelope(
        asResult(await handler(publicShareEvent())),
        410,
        'SHARE_GONE',
      );
    });

    it('returns 410 SHARE_GONE when the item was deleted', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
          const { PK, SK } = command.input.Key ?? { PK: '', SK: '' };
          if (PK === `SHARE#${SHARE_TOKEN}` && SK === 'SHARE') {
            return { Item: dynamoShare() };
          }
          return {};
        }
        return {};
      });

      expectEnvelope(
        asResult(await handler(publicShareEvent())),
        410,
        'SHARE_GONE',
      );
    });

    it('does not require an authorizer context', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
          const { PK, SK } = command.input.Key ?? { PK: '', SK: '' };
          if (PK === `SHARE#${SHARE_TOKEN}`) {
            return { Item: dynamoShare() };
          }
          if (SK === `ITEM#${ITEM_ID}`) {
            return { Item: dynamoItem() };
          }
          return {};
        }
        return {};
      });

      const result = asResult(await handler(publicShareEvent()));
      expect(result.statusCode).toBe(200);
    });
  });

  describe('DELETE /shares/{token}', () => {
    it('revokes an owned token with 204', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
          return { Item: dynamoShare() };
        }
        if (command._op === 'Update') {
          return {
            Attributes: dynamoShare({ revokedAt: '2026-09-19T13:00:00.000Z' }),
          };
        }
        throw new Error(`unexpected Dynamo op ${command._op}`);
      });

      const result = asResult(await handler(revokeEvent()));
      expect(result.statusCode).toBe(204);
      expect(result.body).toBe('');

      const update = mockSend.mock.calls
        .map((call) => call[0] as Command)
        .find((command) => command._op === 'Update');
      expect(update?.input.Key).toEqual({
        PK: `SHARE#${SHARE_TOKEN}`,
        SK: 'SHARE',
      });
      expect(update?.input.UpdateExpression).toContain('revokedAt');
    });

    it('is idempotent when the token is already gone', async () => {
      mockSend.mockResolvedValue({});

      const missing = asResult(await handler(revokeEvent()));
      expect(missing.statusCode).toBe(204);

      const invalid = asResult(await handler(revokeEvent('nope')));
      expect(invalid.statusCode).toBe(204);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('returns 404 SHARE_NOT_FOUND for another user\'s token', async () => {
      mockSend.mockResolvedValue({ Item: dynamoShare() });

      const result = asResult(await handler(revokeEvent(SHARE_TOKEN, { sub: OTHER_ID })));
      expectEnvelope(result, 404, 'SHARE_NOT_FOUND');
    });

    it('returns 204 when the token is already revoked', async () => {
      mockSend.mockResolvedValue({
        Item: dynamoShare({ revokedAt: '2026-09-19T13:00:00.000Z' }),
      });

      const result = asResult(await handler(revokeEvent()));
      expect(result.statusCode).toBe(204);
      const update = mockSend.mock.calls
        .map((call) => call[0] as Command)
        .find((command) => command._op === 'Update');
      expect(update).toBeUndefined();
    });
  });
});
