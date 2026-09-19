import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ClothingItem, DynamoItem } from '../../src/shared/types';

const mockSend = jest.fn();
const mockSqsSend = jest.fn();
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
  TransactWriteCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'TransactWrite',
    input,
  })),
}));

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({ send: mockSqsSend })),
  SendMessageCommand: jest.fn(),
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

import { handler } from '../../src/functions/items/handler';
import { outfitReferencesItem } from '../../src/functions/items/transfer';
import { dynamoEntitlement, isEntitlementGet } from '../helpers/entitlements';

const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OWNER_ID = 'firebase-uid-owner';
const OTHER_ID = 'firebase-uid-other';
const SOURCE_WARDROBE_ID = 'wd_abc123xyz0';
const TARGET_WARDROBE_ID = 'wd_other12ab';
const ITEM_ID = 'item_xyz123abcd';
const OWNER_IMAGE_KEY = `users/${OWNER_ID}/uploads/photo.jpg`;
const OWNER_PROCESSED_KEY = `users/${OWNER_ID}/items/${ITEM_ID}/processed.png`;
const ORIGINAL_IMAGE_URL = 'https://signed.example/original.jpg';
const PROCESSED_IMAGE_URL = 'https://signed.example/processed.png';

interface Command {
  _op: 'Put' | 'Get' | 'Query' | 'Update' | 'Delete' | 'TransactWrite';
  input: {
    TableName?: string;
    Item?: DynamoItem;
    Key?: { PK: string; SK: string };
    KeyConditionExpression?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
    TransactItems?: Array<{
      Put?: {
        TableName?: string;
        Item?: DynamoItem;
        ConditionExpression?: string;
      };
      Delete?: {
        TableName?: string;
        Key?: { PK: string; SK: string };
        ConditionExpression?: string;
      };
    }>;
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

function dynamoWardrobe(
  wardrobeId: string,
  userId = OWNER_ID,
): DynamoItem {
  return {
    PK: `USER#${userId}`,
    SK: `WARDROBE#${wardrobeId}`,
    entityType: 'WARDROBE',
    userId,
    wardrobeId,
    name: wardrobeId === TARGET_WARDROBE_ID ? 'Winter' : 'Summer Clothes',
    createdAt: '2026-09-03T18:35:00.000Z',
    updatedAt: '2026-09-03T18:35:00.000Z',
  };
}

function dynamoItem(
  overrides: Partial<DynamoItem> = {},
  userId = OWNER_ID,
): DynamoItem {
  return {
    PK: `WARDROBE#${SOURCE_WARDROBE_ID}`,
    SK: `ITEM#${ITEM_ID}`,
    entityType: 'ITEM',
    userId,
    wardrobeId: SOURCE_WARDROBE_ID,
    itemId: ITEM_ID,
    name: 'Black T-Shirt',
    category: 'TOP',
    subcategory: 'TSHIRT',
    colours: ['BLACK'],
    brand: 'Nike',
    acquiredAt: '2024-06-15',
    originalKey: OWNER_IMAGE_KEY,
    processedKey: OWNER_PROCESSED_KEY,
    processingStatus: 'READY',
    ai: {
      detectedCategory: 'TOP',
      detectedSubcategory: 'TSHIRT',
      detectedColours: ['BLACK'],
      backgroundRemoved: true,
      processedImageKey: OWNER_PROCESSED_KEY,
    },
    createdAt: '2026-09-03T18:45:00.000Z',
    updatedAt: '2026-09-03T18:45:00.000Z',
    ...overrides,
  };
}

function dynamoOutfit(itemId = ITEM_ID): DynamoItem {
  return {
    PK: `WARDROBE#${SOURCE_WARDROBE_ID}`,
    SK: 'OUTFIT#outfit_friday1',
    entityType: 'OUTFIT',
    userId: OWNER_ID,
    wardrobeId: SOURCE_WARDROBE_ID,
    outfitId: 'outfit_friday1',
    name: 'Friday Night',
    items: [{ itemId, slot: 'TOP' }],
    createdAt: '2026-09-03T19:10:00.000Z',
    updatedAt: '2026-09-03T19:10:00.000Z',
  };
}

function event(options: {
  method: string;
  action: 'move' | 'copy';
  wardrobeId?: string;
  itemId?: string;
  body?: unknown;
  rawBody?: string;
  sub?: string | null;
}): APIGatewayProxyEventV2 {
  const wardrobeId = options.wardrobeId ?? SOURCE_WARDROBE_ID;
  const itemId = options.itemId ?? ITEM_ID;
  const authorizer =
    options.sub === null
      ? undefined
      : {
          lambda: { sub: options.sub ?? OWNER_ID },
        };

  const rawPath = `/wardrobes/${wardrobeId}/items/${itemId}/${options.action}`;
  const routeKey = `${options.method} /wardrobes/{wardrobeId}/items/{itemId}/${options.action}`;

  return {
    version: '2.0',
    routeKey,
    rawPath,
    rawQueryString: '',
    headers: { authorization: 'Bearer unused-in-handler' },
    body:
      options.rawBody !== undefined
        ? options.rawBody
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined,
    pathParameters: { wardrobeId, itemId },
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

function wardrobeGet(command: Command, wardrobeId: string): boolean {
  return (
    command._op === 'Get' &&
    command.input.Key?.PK === `USER#${OWNER_ID}` &&
    command.input.Key?.SK === `WARDROBE#${wardrobeId}`
  );
}

function itemGet(command: Command): boolean {
  return (
    command._op === 'Get' &&
    command.input.Key?.PK === `WARDROBE#${SOURCE_WARDROBE_ID}` &&
    command.input.Key?.SK === `ITEM#${ITEM_ID}`
  );
}

function mockHappyPath(options?: {
  item?: DynamoItem;
  outfits?: DynamoItem[];
  entitlement?: DynamoItem | undefined;
  extra?: (command: Command) => Promise<unknown> | unknown;
}): void {
  mockSend.mockImplementation(async (command: Command) => {
    if (isEntitlementGet(command)) {
      return options && 'entitlement' in options
        ? { Item: options.entitlement }
        : { Item: dynamoEntitlement(OWNER_ID, 'PREMIUM') };
    }
    if (wardrobeGet(command, SOURCE_WARDROBE_ID)) {
      return { Item: dynamoWardrobe(SOURCE_WARDROBE_ID) };
    }
    if (wardrobeGet(command, TARGET_WARDROBE_ID)) {
      return { Item: dynamoWardrobe(TARGET_WARDROBE_ID) };
    }
    if (itemGet(command)) {
      return { Item: options?.item ?? dynamoItem() };
    }
    if (command._op === 'Query') {
      return { Items: options?.outfits ?? [] };
    }
    if (command._op === 'TransactWrite' || command._op === 'Put') {
      return {};
    }
    if (options?.extra) {
      return options.extra(command);
    }
    throw new Error(`unexpected op ${command._op} ${JSON.stringify(command.input.Key)}`);
  });
}

describe('item move/copy (WARDROBE-118)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
    process.env.PROCESSING_QUEUE_URL =
      'https://sqs.eu-west-1.amazonaws.com/123456789012/wardrobe-item-processing-test';
    process.env.MEDIA_BUCKET_NAME = 'wardrobe-media-test';
    mockGetSignedUrl.mockImplementation(
      async (_client: unknown, command: { input?: { Key?: string } }) => {
        const key = command.input?.Key ?? '';
        return key.includes('processed')
          ? PROCESSED_IMAGE_URL
          : ORIGINAL_IMAGE_URL;
      },
    );
  });

  afterEach(() => {
    delete process.env.TABLE_NAME;
    delete process.env.PROCESSING_QUEUE_URL;
    delete process.env.MEDIA_BUCKET_NAME;
  });

  describe('POST /wardrobes/{wardrobeId}/items/{itemId}/move', () => {
    it('re-keys the Dynamo item to the target wardrobe and keeps itemId + images', async () => {
      mockHappyPath();

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            action: 'move',
            body: { targetWardrobeId: TARGET_WARDROBE_ID, userId: OTHER_ID },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      const body = bodyOf(result) as ClothingItem;
      expect(body).toEqual({
        itemId: ITEM_ID,
        wardrobeId: TARGET_WARDROBE_ID,
        name: 'Black T-Shirt',
        category: 'TOP',
        subcategory: 'TSHIRT',
        colours: ['BLACK'],
        brand: 'Nike',
        acquiredAt: '2024-06-15',
        image: {
          originalKey: OWNER_IMAGE_KEY,
          processedKey: OWNER_PROCESSED_KEY,
        },
        originalImageUrl: ORIGINAL_IMAGE_URL,
        processedImageUrl: PROCESSED_IMAGE_URL,
        processingStatus: 'READY',
        createdAt: '2026-09-03T18:45:00.000Z',
        updatedAt: expect.stringMatching(ISO8601),
      });
      expect(body).not.toHaveProperty('userId');
      expect(body).not.toHaveProperty('PK');
      expect(body).not.toHaveProperty('ai');
      expect(body.updatedAt).not.toBe(body.createdAt);

      const transact = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'TransactWrite',
      )?.[0] as Command;
      expect(transact.input.TransactItems).toHaveLength(2);
      expect(transact.input.TransactItems?.[0].Put).toEqual(
        expect.objectContaining({
          TableName: 'wardrobe-app-test',
          ConditionExpression: 'attribute_not_exists(PK)',
          Item: expect.objectContaining({
            PK: `WARDROBE#${TARGET_WARDROBE_ID}`,
            SK: `ITEM#${ITEM_ID}`,
            entityType: 'ITEM',
            userId: OWNER_ID,
            wardrobeId: TARGET_WARDROBE_ID,
            itemId: ITEM_ID,
            originalKey: OWNER_IMAGE_KEY,
            processedKey: OWNER_PROCESSED_KEY,
            processingStatus: 'READY',
            createdAt: '2026-09-03T18:45:00.000Z',
            ai: expect.objectContaining({
              detectedCategory: 'TOP',
              processedImageKey: OWNER_PROCESSED_KEY,
            }),
          }),
        }),
      );
      expect(transact.input.TransactItems?.[1].Delete).toEqual({
        TableName: 'wardrobe-app-test',
        Key: { PK: `WARDROBE#${SOURCE_WARDROBE_ID}`, SK: `ITEM#${ITEM_ID}` },
        ConditionExpression: 'attribute_exists(PK)',
      });
      expect(mockSqsSend).not.toHaveBeenCalled();
    });

    it('rejects a move when the item is used in a source outfit', async () => {
      mockHappyPath({ outfits: [dynamoOutfit()] });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            action: 'move',
            body: { targetWardrobeId: TARGET_WARDROBE_ID },
          }),
        ),
      );

      expectEnvelope(result, 400, 'VALIDATION_ERROR');
      expect((bodyOf(result) as { error: { message: string } }).error.message).toContain(
        'outfit_friday1',
      );
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'TransactWrite'),
      ).toBe(false);
    });

    it('does not apply the Free item cap on move', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (wardrobeGet(command, SOURCE_WARDROBE_ID)) {
          return { Item: dynamoWardrobe(SOURCE_WARDROBE_ID) };
        }
        if (wardrobeGet(command, TARGET_WARDROBE_ID)) {
          return { Item: dynamoWardrobe(TARGET_WARDROBE_ID) };
        }
        if (itemGet(command)) {
          return { Item: dynamoItem() };
        }
        if (command._op === 'Query') {
          return { Items: [] };
        }
        if (command._op === 'TransactWrite') {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            action: 'move',
            body: { targetWardrobeId: TARGET_WARDROBE_ID },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect((bodyOf(result) as ClothingItem).itemId).toBe(ITEM_ID);
      expect(
        mockSend.mock.calls.some((call) => isEntitlementGet(call[0] as Command)),
      ).toBe(false);
    });
  });

  describe('POST /wardrobes/{wardrobeId}/items/{itemId}/copy', () => {
    it('creates a new item in the target wardrobe that shares S3 keys and AI metadata', async () => {
      mockHappyPath();

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            action: 'copy',
            body: { targetWardrobeId: TARGET_WARDROBE_ID, userId: OTHER_ID },
          }),
        ),
      );

      expect(result.statusCode).toBe(201);
      const body = bodyOf(result) as ClothingItem;
      expect(body.itemId).toMatch(/^item_[A-Za-z0-9_-]{12}$/);
      expect(body.itemId).not.toBe(ITEM_ID);
      expect(body.wardrobeId).toBe(TARGET_WARDROBE_ID);
      expect(body.image).toEqual({
        originalKey: OWNER_IMAGE_KEY,
        processedKey: OWNER_PROCESSED_KEY,
      });
      expect(body.originalImageUrl).toBe(ORIGINAL_IMAGE_URL);
      expect(body.processedImageUrl).toBe(PROCESSED_IMAGE_URL);
      expect(body.processingStatus).toBe('READY');
      expect(body.createdAt).toEqual(expect.stringMatching(ISO8601));
      expect(body.updatedAt).toBe(body.createdAt);
      expect(body).not.toHaveProperty('userId');
      expect(body).not.toHaveProperty('PK');

      const put = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Put',
      )?.[0] as Command;
      expect(put.input.Item).toEqual(
        expect.objectContaining({
          PK: `WARDROBE#${TARGET_WARDROBE_ID}`,
          SK: `ITEM#${body.itemId}`,
          entityType: 'ITEM',
          userId: OWNER_ID,
          wardrobeId: TARGET_WARDROBE_ID,
          itemId: body.itemId,
          originalKey: OWNER_IMAGE_KEY,
          processedKey: OWNER_PROCESSED_KEY,
          processingStatus: 'READY',
          ai: expect.objectContaining({
            detectedCategory: 'TOP',
            processedImageKey: OWNER_PROCESSED_KEY,
          }),
        }),
      );
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'TransactWrite'),
      ).toBe(false);
      expect(mockSqsSend).not.toHaveBeenCalled();
    });

    it('allows copy when the source item is used in an outfit', async () => {
      mockHappyPath({ outfits: [dynamoOutfit()] });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            action: 'copy',
            body: { targetWardrobeId: TARGET_WARDROBE_ID },
          }),
        ),
      );

      expect(result.statusCode).toBe(201);
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Query'),
      ).toBe(false);
    });

    it('rejects a sixth copy on Free with ENTITLEMENT_ITEM_LIMIT', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (isEntitlementGet(command)) {
          return {};
        }
        if (wardrobeGet(command, SOURCE_WARDROBE_ID)) {
          return { Item: dynamoWardrobe(SOURCE_WARDROBE_ID) };
        }
        if (wardrobeGet(command, TARGET_WARDROBE_ID)) {
          return { Item: dynamoWardrobe(TARGET_WARDROBE_ID) };
        }
        if (itemGet(command)) {
          return { Item: dynamoItem() };
        }
        if (command._op === 'Query') {
          const pk = command.input.ExpressionAttributeValues?.[':pk'];
          if (pk === `USER#${OWNER_ID}`) {
            return { Items: [dynamoWardrobe(SOURCE_WARDROBE_ID)] };
          }
          return {
            Items: Array.from({ length: 5 }, (_, index) =>
              dynamoItem({
                itemId: `item_lim${index}abcd`,
                SK: `ITEM#item_lim${index}abcd`,
              }),
            ),
          };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            action: 'copy',
            body: { targetWardrobeId: TARGET_WARDROBE_ID },
          }),
        ),
      );

      expectEnvelope(result, 403, 'ENTITLEMENT_ITEM_LIMIT');
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Put'),
      ).toBe(false);
      expect(mockSqsSend).not.toHaveBeenCalled();
    });
  });

  describe('shared validation', () => {
    it('returns 401 when the authorizer identity is missing', async () => {
      const result = asResult(
        await handler(
          event({
            method: 'POST',
            action: 'move',
            body: { targetWardrobeId: TARGET_WARDROBE_ID },
            sub: null,
          }),
        ),
      );
      expectEnvelope(result, 401, 'UNAUTHENTICATED');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns 400 when targetWardrobeId is missing', async () => {
      const result = asResult(
        await handler(event({ method: 'POST', action: 'move', body: {} })),
      );
      expectEnvelope(result, 400, 'VALIDATION_ERROR');
    });

    it('returns 400 when the target is the source wardrobe', async () => {
      mockHappyPath();
      const result = asResult(
        await handler(
          event({
            method: 'POST',
            action: 'copy',
            body: { targetWardrobeId: SOURCE_WARDROBE_ID },
          }),
        ),
      );
      expectEnvelope(result, 400, 'VALIDATION_ERROR');
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Put'),
      ).toBe(false);
    });

    it('returns 404 WARDROBE_NOT_FOUND for another user source wardrobe', async () => {
      mockSend.mockResolvedValue({});
      const result = asResult(
        await handler(
          event({
            method: 'POST',
            action: 'move',
            body: { targetWardrobeId: TARGET_WARDROBE_ID },
            sub: OTHER_ID,
          }),
        ),
      );
      expectEnvelope(result, 404, 'WARDROBE_NOT_FOUND');
    });

    it('returns 404 ITEM_NOT_FOUND when the source item is missing', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (wardrobeGet(command, SOURCE_WARDROBE_ID)) {
          return { Item: dynamoWardrobe(SOURCE_WARDROBE_ID) };
        }
        if (itemGet(command)) {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            action: 'copy',
            body: { targetWardrobeId: TARGET_WARDROBE_ID },
          }),
        ),
      );
      expectEnvelope(result, 404, 'ITEM_NOT_FOUND');
    });

    it('returns 404 WARDROBE_NOT_FOUND when the target wardrobe is missing', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (wardrobeGet(command, SOURCE_WARDROBE_ID)) {
          return { Item: dynamoWardrobe(SOURCE_WARDROBE_ID) };
        }
        if (itemGet(command)) {
          return { Item: dynamoItem() };
        }
        if (wardrobeGet(command, TARGET_WARDROBE_ID)) {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            action: 'move',
            body: { targetWardrobeId: TARGET_WARDROBE_ID },
          }),
        ),
      );
      expectEnvelope(result, 404, 'WARDROBE_NOT_FOUND');
    });

    it.each(['PENDING', 'PROCESSING'] as const)(
      'rejects %s items so the processing worker is not orphaned',
      async (processingStatus) => {
        mockHappyPath({ item: dynamoItem({ processingStatus }) });
        const result = asResult(
          await handler(
            event({
              method: 'POST',
              action: 'move',
              body: { targetWardrobeId: TARGET_WARDROBE_ID },
            }),
          ),
        );
        expectEnvelope(result, 400, 'VALIDATION_ERROR');
        expect(
          mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'TransactWrite'),
        ).toBe(false);
      },
    );

    it('allows FAILED items (copy keeps processingError)', async () => {
      mockHappyPath({
        item: dynamoItem({
          processingStatus: 'FAILED',
          processingError: 'Gemini did not return an image.',
        }),
      });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            action: 'copy',
            body: { targetWardrobeId: TARGET_WARDROBE_ID },
          }),
        ),
      );

      expect(result.statusCode).toBe(201);
      const body = bodyOf(result) as ClothingItem;
      expect(body.processingStatus).toBe('FAILED');
      expect(body.processingError).toBe('Gemini did not return an image.');
    });

    it('rejects unsupported methods on the transfer routes', async () => {
      const result = asResult(
        await handler(
          event({
            method: 'GET',
            action: 'move',
            body: { targetWardrobeId: TARGET_WARDROBE_ID },
          }),
        ),
      );
      expectEnvelope(result, 400, 'VALIDATION_ERROR');
    });
  });

  describe('outfitReferencesItem', () => {
    it('matches a stored outfit itemId', () => {
      expect(outfitReferencesItem(dynamoOutfit(), ITEM_ID)).toBe(true);
      expect(outfitReferencesItem(dynamoOutfit('item_other12ab'), ITEM_ID)).toBe(
        false,
      );
      expect(outfitReferencesItem(dynamoOutfit(), 'item_missing')).toBe(false);
    });
  });
});
