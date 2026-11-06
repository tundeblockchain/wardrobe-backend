import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DynamoItem, WISHLIST_MAX_ITEMS } from '../../src/shared/types';
import { MAX_UPLOAD_BYTES, PRESIGNED_URL_EXPIRES_IN } from '../../src/shared/s3';

const mockSend = jest.fn();
const mockSqsSend = jest.fn();
const mockGetSignedUrl = jest.fn();
const mockDeleteObjectBestEffort = jest.fn();
const mockCopyObject = jest.fn();

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
  TransactWriteCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'TransactWrite',
    input,
  })),
}));

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({ send: mockSqsSend })),
  SendMessageCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'SendMessage',
    input,
  })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

jest.mock('../../src/shared/s3', () => {
  const actual = jest.requireActual('../../src/shared/s3') as typeof import('../../src/shared/s3');
  return {
    ...actual,
    deleteObjectBestEffort: (...args: unknown[]) =>
      mockDeleteObjectBestEffort(...args),
    copyObject: (...args: unknown[]) => mockCopyObject(...args),
  };
});

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({})),
  GetObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'GetObject',
    input,
  })),
  PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'PutObject',
    input,
  })),
  CopyObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'CopyObject',
    input,
  })),
  ListObjectsV2Command: jest.fn(),
  DeleteObjectsCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
}));

import { handler } from '../../src/functions/wishlist/handler';
import {
  dynamoEntitlement,
  entitlementReadResult,
  isEntitlementGet,
} from '../helpers/entitlements';

const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OWNER_ID = 'firebase-uid-owner';
const OTHER_ID = 'firebase-uid-other';
const WARDROBE_ID = 'wd_abc123xyz0';
const WISH_ID = 'wish_abc123xyz0';
const OWNER_IMAGE_KEY = `users/${OWNER_ID}/wishlist/uploads/photo.jpg`;
const SIGNED_GET = 'https://signed.example/wish.jpg';
const SIGNED_PUT =
  'https://wardrobe-media-test.s3.amazonaws.com/users/firebase-uid-owner/wishlist/uploads/abc.jpg?X-Amz-Signature=test';

interface TransactPut {
  TableName?: string;
  Item?: DynamoItem;
  ConditionExpression?: string;
}

interface TransactDelete {
  TableName?: string;
  Key?: { PK: string; SK: string };
  ConditionExpression?: string;
}

interface Command {
  _op: 'Put' | 'Get' | 'Query' | 'Update' | 'Delete' | 'TransactWrite';
  input: {
    TableName?: string;
    Item?: DynamoItem;
    Key?: { PK: string; SK: string };
    KeyConditionExpression?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
    TransactItems?: Array<{ Put?: TransactPut; Delete?: TransactDelete }>;
    UpdateExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
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
  message?: string,
): void {
  expect(result.statusCode).toBe(statusCode);
  expect(bodyOf(result)).toEqual({
    error: {
      code,
      message: message ?? expect.any(String),
    },
  });
}

function mutatingCommands(): Command[] {
  return mockSend.mock.calls
    .map((call) => call[0] as Command)
    .filter((command) =>
      ['Put', 'Update', 'Delete', 'TransactWrite'].includes(command._op),
    );
}

function transactCommands(): Command[] {
  return mutatingCommands().filter((command) => command._op === 'TransactWrite');
}

function transactionCanceled(message = 'ConditionalCheckFailed'): Error {
  const error = new Error(message);
  error.name = 'TransactionCanceledException';
  return error;
}

function acquireEvent(
  overrides: {
    wishId?: string;
    body?: unknown;
    sub?: string | null;
  } = {},
): APIGatewayProxyEventV2 {
  const wishId = overrides.wishId ?? WISH_ID;
  return event({
    method: 'POST',
    path: `/wishlist/${wishId}/acquire`,
    wishId,
    body: overrides.body ?? { wardrobeId: WARDROBE_ID },
    sub: overrides.sub,
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

function dynamoWish(
  userId = OWNER_ID,
  overrides: Partial<DynamoItem> = {},
): DynamoItem {
  return {
    PK: `USER#${userId}`,
    SK: `WISH#${WISH_ID}`,
    entityType: 'WISH',
    userId,
    wishId: WISH_ID,
    name: 'Wanted coat',
    category: 'OUTERWEAR',
    subcategory: 'COAT',
    originalKey: OWNER_IMAGE_KEY,
    link: 'https://shop.example/coat',
    price: { amount: 89.5, currency: 'GBP' },
    notes: 'Black wool',
    createdAt: '2026-11-06T10:00:00.000Z',
    updatedAt: '2026-11-06T10:00:00.000Z',
    ...overrides,
  };
}

function event(options: {
  method: string;
  path?: string;
  wishId?: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  sub?: string | null;
}): APIGatewayProxyEventV2 {
  const authorizer =
    options.sub === null
      ? undefined
      : {
          lambda: { sub: options.sub ?? OWNER_ID },
        };

  const rawPath =
    options.path ??
    (options.wishId ? `/wishlist/${options.wishId}` : '/wishlist');
  const routeKey = options.path
    ? `${options.method} ${options.path.replace(/\/wish_[^/]+/, '/{wishId}').replace(/\/wishlist\/[^/]+\/acquire/, '/wishlist/{wishId}/acquire')}`
    : options.wishId
      ? `${options.method} /wishlist/{wishId}`
      : `${options.method} /wishlist`;

  return {
    version: '2.0',
    routeKey,
    rawPath,
    rawQueryString: '',
    headers: { authorization: 'Bearer unused-in-handler' },
    queryStringParameters: options.query,
    pathParameters: options.wishId ? { wishId: options.wishId } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'example.com',
      domainPrefix: 'example',
      http: {
        method: options.method,
        path: rawPath,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'jest',
      },
      requestId: 'req-1',
      routeKey,
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
      authorizer,
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

describe('wishlist handler (WARDROBE-244)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
    process.env.MEDIA_BUCKET_NAME = 'wardrobe-media-test';
    process.env.PROCESSING_QUEUE_URL = 'https://sqs.test/processing';
    mockGetSignedUrl.mockResolvedValue(SIGNED_GET);
    mockCopyObject.mockResolvedValue(undefined);
    mockDeleteObjectBestEffort.mockResolvedValue(undefined);
    mockSqsSend.mockResolvedValue({});
  });

  afterEach(() => {
    delete process.env.TABLE_NAME;
    delete process.env.MEDIA_BUCKET_NAME;
    delete process.env.PROCESSING_QUEUE_URL;
  });

  describe('POST /wishlist', () => {
    it('creates a wish for a Free user without an entitlement check (200-class 201)', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Query') {
          return { Items: [] };
        }
        if (command._op === 'Put') {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            body: {
              name: 'Linen shirt',
              category: 'TOP',
              subcategory: 'SHIRT',
              imageKey: OWNER_IMAGE_KEY,
              link: 'https://shop.example/shirt',
              price: { amount: 45, currency: 'eur' },
              notes: 'Summer',
            },
          }),
        ),
      );

      expect(result.statusCode).toBe(201);
      const body = bodyOf(result) as Record<string, unknown>;
      expect(body.name).toBe('Linen shirt');
      expect(body.category).toBe('TOP');
      expect(body.subcategory).toBe('SHIRT');
      expect(body.link).toBe('https://shop.example/shirt');
      expect(body.price).toEqual({ amount: 45, currency: 'EUR' });
      expect(body.notes).toBe('Summer');
      expect(body.wishId).toMatch(/^wish_/);
      expect(body.createdAt).toMatch(ISO8601);
      expect(body).not.toHaveProperty('PK');
      expect(body).not.toHaveProperty('userId');

      const put = mockSend.mock.calls
        .map((call) => call[0] as Command)
        .find((command) => command._op === 'Put');
      expect(put?.input.Item?.entityType).toBe('WISH');
      expect(put?.input.Item?.PK).toBe(`USER#${OWNER_ID}`);
      expect(put?.input.Item?.SK).toMatch(/^WISH#wish_/);
      expect(
        mockSend.mock.calls.some((call) => isEntitlementGet(call[0] as Command)),
      ).toBe(false);
    });

    it('returns 409 WISHLIST_LIMIT on the 501st wish', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Query') {
          return {
            Items: Array.from({ length: WISHLIST_MAX_ITEMS }, (_, index) =>
              dynamoWish(OWNER_ID, {
                wishId: `wish_fill${index}`,
                SK: `WISH#wish_fill${index}`,
              }),
            ),
          };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'POST', body: { name: 'One more' } })),
      );

      expectEnvelope(
        result,
        409,
        'WISHLIST_LIMIT',
        'Wish list can hold 500 items.',
      );
      expect(mutatingCommands()).toEqual([]);
    });

    it('rejects http links and unknown categories', async () => {
      mockSend.mockResolvedValue({ Items: [] });

      const httpLink = asResult(
        await handler(
          event({
            method: 'POST',
            body: { name: 'Coat', link: 'http://shop.example/coat' },
          }),
        ),
      );
      expectEnvelope(httpLink, 400, 'VALIDATION_ERROR');

      const category = asResult(
        await handler(
          event({
            method: 'POST',
            body: { name: 'Coat', category: 'HAT' },
          }),
        ),
      );
      expectEnvelope(category, 400, 'VALIDATION_ERROR');
    });

    it('requires a name', async () => {
      const result = asResult(
        await handler(event({ method: 'POST', body: { category: 'TOP' } })),
      );
      expectEnvelope(result, 400, 'VALIDATION_ERROR');
    });
  });

  describe('GET /wishlist', () => {
    it('returns 200 for a Free user, newest first', async () => {
      const older = dynamoWish(OWNER_ID, {
        wishId: 'wish_old0000001',
        SK: 'WISH#wish_old0000001',
        createdAt: '2026-11-01T00:00:00.000Z',
        name: 'Older',
      });
      const newer = dynamoWish(OWNER_ID, {
        wishId: 'wish_new0000001',
        SK: 'WISH#wish_new0000001',
        createdAt: '2026-11-06T00:00:00.000Z',
        name: 'Newer',
      });
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Query') {
          expect(command.input.ExpressionAttributeValues?.[':pk']).toBe(
            `USER#${OWNER_ID}`,
          );
          expect(command.input.ExpressionAttributeValues?.[':sk']).toBe('WISH#');
          return { Items: [older, newer] };
        }
        return {};
      });

      const result = asResult(await handler(event({ method: 'GET' })));
      expect(result.statusCode).toBe(200);
      const body = bodyOf(result) as { wishes: Array<{ name: string }> };
      expect(body.wishes.map((wish) => wish.name)).toEqual(['Newer', 'Older']);
      expect(
        mockSend.mock.calls.some((call) => isEntitlementGet(call[0] as Command)),
      ).toBe(false);
    });

    it('filters by category and paginates', async () => {
      const wishes = [
        dynamoWish(OWNER_ID, {
          wishId: 'wish_a',
          SK: 'WISH#wish_a',
          category: 'TOP',
          createdAt: '2026-11-06T03:00:00.000Z',
        }),
        dynamoWish(OWNER_ID, {
          wishId: 'wish_b',
          SK: 'WISH#wish_b',
          category: 'TOP',
          createdAt: '2026-11-06T02:00:00.000Z',
        }),
        dynamoWish(OWNER_ID, {
          wishId: 'wish_c',
          SK: 'WISH#wish_c',
          category: 'SHOES',
          createdAt: '2026-11-06T04:00:00.000Z',
        }),
      ];
      mockSend.mockResolvedValue({ Items: wishes });

      const first = asResult(
        await handler(
          event({ method: 'GET', query: { category: 'TOP', limit: '1' } }),
        ),
      );
      expect(first.statusCode).toBe(200);
      const firstBody = bodyOf(first) as {
        wishes: Array<{ wishId: string }>;
        nextCursor?: string;
      };
      expect(firstBody.wishes).toHaveLength(1);
      expect(firstBody.wishes[0]?.wishId).toBe('wish_a');
      expect(firstBody.nextCursor).toEqual(expect.any(String));

      const second = asResult(
        await handler(
          event({
            method: 'GET',
            query: { category: 'TOP', limit: '1', cursor: firstBody.nextCursor },
          }),
        ),
      );
      const secondBody = bodyOf(second) as {
        wishes: Array<{ wishId: string }>;
        nextCursor?: string;
      };
      expect(secondBody.wishes[0]?.wishId).toBe('wish_b');
      expect(secondBody.nextCursor).toBeUndefined();
    });
  });

  describe('GET /wishlist/{wishId}', () => {
    it('returns 404 WISH_NOT_FOUND for another user id', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(
          event({ method: 'GET', wishId: WISH_ID, sub: OTHER_ID }),
        ),
      );

      expectEnvelope(result, 404, 'WISH_NOT_FOUND');
      const get = mockSend.mock.calls[0][0] as Command;
      expect(get.input.Key).toEqual({
        PK: `USER#${OTHER_ID}`,
        SK: `WISH#${WISH_ID}`,
      });
    });

    it('returns the owner wish', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
          return { Item: dynamoWish() };
        }
        return {};
      });

      const result = asResult(
        await handler(event({ method: 'GET', wishId: WISH_ID })),
      );
      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual(
        expect.objectContaining({
          wishId: WISH_ID,
          name: 'Wanted coat',
          originalImageUrl: SIGNED_GET,
        }),
      );
    });
  });

  describe('PATCH /wishlist/{wishId}', () => {
    it('updates fields and 404s for another user', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
          return { Item: dynamoWish() };
        }
        if (command._op === 'Update') {
          return {
            Attributes: {
              ...dynamoWish(),
              name: 'Updated coat',
              updatedAt: '2026-11-06T12:00:00.000Z',
            },
          };
        }
        return {};
      });

      const okResult = asResult(
        await handler(
          event({
            method: 'PATCH',
            wishId: WISH_ID,
            body: { name: 'Updated coat' },
          }),
        ),
      );
      expect(okResult.statusCode).toBe(200);
      expect((bodyOf(okResult) as { name: string }).name).toBe('Updated coat');

      mockSend.mockResolvedValue({});
      const forbidden = asResult(
        await handler(
          event({
            method: 'PATCH',
            wishId: WISH_ID,
            body: { name: 'Stolen' },
            sub: OTHER_ID,
          }),
        ),
      );
      expectEnvelope(forbidden, 404, 'WISH_NOT_FOUND');
    });
  });

  describe('DELETE /wishlist/{wishId}', () => {
    it('deletes the wish and its image', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
          return { Item: dynamoWish() };
        }
        if (command._op === 'Delete') {
          return {};
        }
        return {};
      });

      const result = asResult(
        await handler(event({ method: 'DELETE', wishId: WISH_ID })),
      );
      expect(result.statusCode).toBe(204);
      expect(mockDeleteObjectBestEffort).toHaveBeenCalledWith(OWNER_IMAGE_KEY);
    });

    it('returns 404 for another user and does not delete', async () => {
      mockSend.mockResolvedValue({});
      const result = asResult(
        await handler(
          event({ method: 'DELETE', wishId: WISH_ID, sub: OTHER_ID }),
        ),
      );
      expectEnvelope(result, 404, 'WISH_NOT_FOUND');
      expect(mockDeleteObjectBestEffort).not.toHaveBeenCalled();
    });
  });

  describe('per-user isolation', () => {
    it('does not let user A read user B wish (404 WISH_NOT_FOUND)', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(
          event({ method: 'GET', wishId: WISH_ID, sub: OTHER_ID }),
        ),
      );

      expectEnvelope(result, 404, 'WISH_NOT_FOUND');
      expect((mockSend.mock.calls[0][0] as Command).input.Key).toEqual({
        PK: `USER#${OTHER_ID}`,
        SK: `WISH#${WISH_ID}`,
      });
      expect(mutatingCommands()).toEqual([]);
    });

    it('does not let user A update user B wish (404 WISH_NOT_FOUND)', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(
          event({
            method: 'PATCH',
            wishId: WISH_ID,
            body: { name: 'Stolen' },
            sub: OTHER_ID,
          }),
        ),
      );

      expectEnvelope(result, 404, 'WISH_NOT_FOUND');
      expect((mockSend.mock.calls[0][0] as Command).input.Key).toEqual({
        PK: `USER#${OTHER_ID}`,
        SK: `WISH#${WISH_ID}`,
      });
      expect(mutatingCommands()).toEqual([]);
    });

    it('does not let user A delete user B wish (404 WISH_NOT_FOUND)', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(
          event({ method: 'DELETE', wishId: WISH_ID, sub: OTHER_ID }),
        ),
      );

      expectEnvelope(result, 404, 'WISH_NOT_FOUND');
      expect((mockSend.mock.calls[0][0] as Command).input.Key).toEqual({
        PK: `USER#${OTHER_ID}`,
        SK: `WISH#${WISH_ID}`,
      });
      expect(mutatingCommands()).toEqual([]);
      expect(mockDeleteObjectBestEffort).not.toHaveBeenCalled();
    });

    it('does not let user A acquire user B wish (404 WISH_NOT_FOUND)', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(acquireEvent({ sub: OTHER_ID })),
      );

      expectEnvelope(result, 404, 'WISH_NOT_FOUND');
      expect((mockSend.mock.calls[0][0] as Command).input.Key).toEqual({
        PK: `USER#${OTHER_ID}`,
        SK: `WISH#${WISH_ID}`,
      });
      expect(mutatingCommands()).toEqual([]);
      expect(mockCopyObject).not.toHaveBeenCalled();
    });
  });

  describe('POST /wishlist/uploads', () => {
    it('returns the same content-type and size limits as clothing item images', async () => {
      mockGetSignedUrl.mockResolvedValue(SIGNED_PUT);

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            path: '/wishlist/uploads',
            body: { contentType: 'image/jpeg', contentLength: 1024 },
          }),
        ),
      );

      expect(result.statusCode).toBe(201);
      expect(bodyOf(result)).toEqual({
        uploadUrl: SIGNED_PUT,
        objectKey: expect.stringMatching(
          new RegExp(`^users/${OWNER_ID}/wishlist/uploads/[A-Za-z0-9_-]{16}\\.jpg$`),
        ),
        expiresIn: PRESIGNED_URL_EXPIRES_IN,
      });
    });

    it('rejects oversized uploads', async () => {
      const result = asResult(
        await handler(
          event({
            method: 'POST',
            path: '/wishlist/uploads',
            body: {
              contentType: 'image/jpeg',
              contentLength: MAX_UPLOAD_BYTES + 1,
            },
          }),
        ),
      );
      expectEnvelope(result, 400, 'UPLOAD_INVALID');
    });
  });

  describe('POST /wishlist/{wishId}/acquire', () => {
    function mockAcquireLookups(options?: {
      onTransact?: (command: Command) => Promise<unknown> | unknown;
    }): void {
      mockSend.mockImplementation(async (command: Command) => {
        if (isEntitlementGet(command)) {
          return entitlementReadResult(dynamoEntitlement(OWNER_ID, 'PREMIUM'));
        }
        if (command._op === 'Get') {
          if (command.input.Key?.SK === `WISH#${WISH_ID}`) {
            return { Item: dynamoWish() };
          }
          if (command.input.Key?.SK === `WARDROBE#${WARDROBE_ID}`) {
            return { Item: dynamoWardrobe() };
          }
        }
        if (command._op === 'TransactWrite') {
          if (options?.onTransact) {
            return options.onTransact(command);
          }
          return {};
        }
        return {};
      });
    }

    it('moves the wish into a wardrobe in one TransactWriteItems', async () => {
      const order: string[] = [];
      mockCopyObject.mockImplementation(async () => {
        order.push('copy');
      });
      mockAcquireLookups({
        onTransact: () => {
          order.push('transact');
          return {};
        },
      });

      const result = asResult(await handler(acquireEvent()));

      expect(result.statusCode).toBe(201);
      const body = bodyOf(result) as {
        itemId: string;
        wardrobeId: string;
        name: string;
        category: string;
        processingStatus: string;
      };
      expect(body.wardrobeId).toBe(WARDROBE_ID);
      expect(body.name).toBe('Wanted coat');
      expect(body.category).toBe('OUTERWEAR');
      expect(body.itemId).toMatch(/^item_/);
      expect(body.processingStatus).toBe('PENDING');
      expect(order).toEqual(['copy', 'transact']);

      const destinationKey = (
        mockCopyObject.mock.calls[0][0] as { destinationKey: string }
      ).destinationKey;
      expect(destinationKey).toMatch(
        new RegExp(`^users/${OWNER_ID}/items/item_.+/original\\.jpg$`),
      );
      expect(mockCopyObject).toHaveBeenCalledWith({
        sourceKey: OWNER_IMAGE_KEY,
        destinationKey,
      });

      const transacts = transactCommands();
      expect(transacts).toHaveLength(1);
      expect(transacts[0].input.TransactItems).toHaveLength(2);
      expect(transacts[0].input.TransactItems?.[0].Put).toEqual(
        expect.objectContaining({
          ConditionExpression: 'attribute_not_exists(PK)',
          Item: expect.objectContaining({
            PK: `WARDROBE#${WARDROBE_ID}`,
            SK: `ITEM#${body.itemId}`,
            entityType: 'ITEM',
            userId: OWNER_ID,
            wardrobeId: WARDROBE_ID,
            itemId: body.itemId,
            originalKey: destinationKey,
            name: 'Wanted coat',
            category: 'OUTERWEAR',
          }),
        }),
      );
      expect(transacts[0].input.TransactItems?.[1].Delete).toEqual({
        TableName: 'wardrobe-app-test',
        Key: { PK: `USER#${OWNER_ID}`, SK: `WISH#${WISH_ID}` },
        ConditionExpression: 'attribute_exists(PK)',
      });
      expect(mockSqsSend).toHaveBeenCalled();
      expect(mockDeleteObjectBestEffort).toHaveBeenCalledWith(OWNER_IMAGE_KEY);
      expect(mockDeleteObjectBestEffort).not.toHaveBeenCalledWith(
        destinationKey,
      );
    });

    it('returns the same ENTITLEMENT_ITEM_LIMIT as a normal create and keeps the wish', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (isEntitlementGet(command)) {
          return {};
        }
        if (command._op === 'Get') {
          if (command.input.Key?.SK === `WISH#${WISH_ID}`) {
            return { Item: dynamoWish() };
          }
          if (command.input.Key?.SK === `WARDROBE#${WARDROBE_ID}`) {
            return { Item: dynamoWardrobe() };
          }
        }
        if (command._op === 'Query') {
          const pk = command.input.ExpressionAttributeValues?.[':pk'];
          if (pk === `USER#${OWNER_ID}`) {
            return { Items: [dynamoWardrobe()] };
          }
          return {
            Items: Array.from({ length: 5 }, (_, index) => ({
              PK: `WARDROBE#${WARDROBE_ID}`,
              SK: `ITEM#item_lim${index}abcd`,
              entityType: 'ITEM',
              userId: OWNER_ID,
              wardrobeId: WARDROBE_ID,
              itemId: `item_lim${index}abcd`,
              createdAt: '2026-09-03T18:45:00.000Z',
              updatedAt: '2026-09-03T18:45:00.000Z',
            })),
          };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(await handler(acquireEvent()));

      expectEnvelope(
        result,
        403,
        'ENTITLEMENT_ITEM_LIMIT',
        'Free plan allows 5 items. Upgrade to Basic or Premium.',
      );
      expect(mockCopyObject).not.toHaveBeenCalled();
      expect(mutatingCommands()).toEqual([]);
      expect(mockDeleteObjectBestEffort).not.toHaveBeenCalled();
      expect(
        mockSend.mock.calls.some(
          (call) =>
            (call[0] as Command)._op === 'Get' &&
            (call[0] as Command).input.Key?.SK === `WISH#${WISH_ID}`,
        ),
      ).toBe(true);
    });

    it('copies the image first and deletes the copy when TransactWriteItems fails (wish remains; not both, not neither)', async () => {
      const order: string[] = [];
      mockCopyObject.mockImplementation(async () => {
        order.push('copy');
      });
      mockDeleteObjectBestEffort.mockImplementation(async () => {
        order.push('cleanup-copy');
      });
      mockAcquireLookups({
        onTransact: () => {
          order.push('transact');
          throw transactionCanceled();
        },
      });

      const result = asResult(await handler(acquireEvent()));

      expectEnvelope(result, 404, 'WISH_NOT_FOUND');
      expect(order).toEqual(['copy', 'transact', 'cleanup-copy']);
      const destinationKey = (
        mockCopyObject.mock.calls[0][0] as { destinationKey: string }
      ).destinationKey;
      expect(mockDeleteObjectBestEffort).toHaveBeenCalledWith(destinationKey);
      expect(mockDeleteObjectBestEffort).not.toHaveBeenCalledWith(
        OWNER_IMAGE_KEY,
      );
      expect(transactCommands()).toHaveLength(1);
      expect(transactCommands()[0].input.TransactItems).toHaveLength(2);
      expect(mutatingCommands().filter((command) => command._op !== 'TransactWrite')).toEqual(
        [],
      );
      expect(mockSqsSend).not.toHaveBeenCalled();
    });

    it('does not write Dynamo when the image copy fails (wish remains)', async () => {
      mockAcquireLookups();
      mockCopyObject.mockRejectedValue(new Error('S3 copy failed'));

      const result = asResult(await handler(acquireEvent()));

      expectEnvelope(result, 500, 'INTERNAL_ERROR');
      expect(transactCommands()).toEqual([]);
      expect(mutatingCommands()).toEqual([]);
      expect(mockDeleteObjectBestEffort).not.toHaveBeenCalled();
      expect(mockSqsSend).not.toHaveBeenCalled();
    });

    it('reverses acquire in one TransactWriteItems when Premium enqueue fails (wish restored, item gone)', async () => {
      mockAcquireLookups();
      mockSqsSend.mockRejectedValue(new Error('sqs unavailable'));

      const result = asResult(await handler(acquireEvent()));

      expectEnvelope(result, 500, 'INTERNAL_ERROR');
      const transacts = transactCommands();
      expect(transacts).toHaveLength(2);
      expect(transacts[0].input.TransactItems?.[0].Put?.Item?.entityType).toBe(
        'ITEM',
      );
      expect(transacts[0].input.TransactItems?.[1].Delete?.Key).toEqual({
        PK: `USER#${OWNER_ID}`,
        SK: `WISH#${WISH_ID}`,
      });
      expect(transacts[1].input.TransactItems).toHaveLength(2);
      expect(transacts[1].input.TransactItems?.[0].Delete?.Key?.PK).toBe(
        `WARDROBE#${WARDROBE_ID}`,
      );
      expect(
        transacts[1].input.TransactItems?.[0].Delete?.ConditionExpression,
      ).toBe('attribute_exists(PK)');
      expect(transacts[1].input.TransactItems?.[1].Put).toEqual(
        expect.objectContaining({
          ConditionExpression: 'attribute_not_exists(PK)',
          Item: expect.objectContaining({
            PK: `USER#${OWNER_ID}`,
            SK: `WISH#${WISH_ID}`,
            entityType: 'WISH',
            wishId: WISH_ID,
          }),
        }),
      );
      const destinationKey = (
        mockCopyObject.mock.calls[0][0] as { destinationKey: string }
      ).destinationKey;
      expect(mockDeleteObjectBestEffort).toHaveBeenCalledWith(destinationKey);
      expect(mockDeleteObjectBestEffort).not.toHaveBeenCalledWith(
        OWNER_IMAGE_KEY,
      );
    });

    it('validates the wardrobe belongs to the caller', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
          if (command.input.Key?.SK === `WISH#${WISH_ID}`) {
            return { Item: dynamoWish() };
          }
          return {};
        }
        return {};
      });

      const result = asResult(await handler(acquireEvent()));
      expectEnvelope(result, 404, 'WARDROBE_NOT_FOUND');
      expect(mockCopyObject).not.toHaveBeenCalled();
      expect(mutatingCommands()).toEqual([]);
    });
  });
});
