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

import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { handler } from '../../src/functions/items/handler';

const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OWNER_ID = 'firebase-uid-owner';
const OTHER_ID = 'firebase-uid-other';
const WARDROBE_ID = 'wd_abc123xyz0';
const ITEM_ID = 'item_xyz123abcd';
const OWNER_IMAGE_KEY = `users/${OWNER_ID}/uploads/photo.jpg`;
const OWNER_PROCESSED_KEY = `users/${OWNER_ID}/items/${ITEM_ID}/processed.png`;
const ORIGINAL_IMAGE_URL = 'https://signed.example/original.jpg';
const PROCESSED_IMAGE_URL = 'https://signed.example/processed.png';

interface Command {
  _op: 'Put' | 'Get' | 'Query' | 'Update' | 'Delete';
  input: {
    TableName?: string;
    Item?: DynamoItem;
    Key?: { PK: string; SK: string };
    KeyConditionExpression?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
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

function itemDto(overrides: Partial<ClothingItem> = {}): ClothingItem {
  return {
    itemId: ITEM_ID,
    wardrobeId: WARDROBE_ID,
    name: 'Black T-Shirt',
    category: 'TOP',
    subcategory: 'TSHIRT',
    colours: ['BLACK'],
    brand: 'Nike',
    image: { originalKey: OWNER_IMAGE_KEY },
    originalImageUrl: ORIGINAL_IMAGE_URL,
    processingStatus: 'READY',
    createdAt: '2026-09-03T18:45:00.000Z',
    updatedAt: '2026-09-03T18:45:00.000Z',
    ...overrides,
  };
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

function dynamoItem(
  userId = OWNER_ID,
  overrides: Partial<DynamoItem> = {},
): DynamoItem {
  const dto = itemDto();
  return {
    PK: `WARDROBE#${dto.wardrobeId}`,
    SK: `ITEM#${dto.itemId}`,
    entityType: 'ITEM',
    userId,
    wardrobeId: dto.wardrobeId,
    itemId: dto.itemId,
    name: dto.name,
    category: dto.category,
    subcategory: dto.subcategory,
    colours: dto.colours,
    brand: dto.brand,
    originalKey: dto.image?.originalKey,
    processingStatus: dto.processingStatus,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    ...overrides,
  };
}

function event(options: {
  method: string;
  wardrobeId?: string;
  itemId?: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  rawBody?: string;
  sub?: string | null;
}): APIGatewayProxyEventV2 {
  const wardrobeId = options.wardrobeId ?? WARDROBE_ID;
  const authorizer =
    options.sub === null
      ? undefined
      : {
          lambda: { sub: options.sub ?? OWNER_ID },
        };

  const rawPath = options.itemId
    ? `/wardrobes/${wardrobeId}/items/${options.itemId}`
    : `/wardrobes/${wardrobeId}/items`;
  const routeKey = options.itemId
    ? `${options.method} /wardrobes/{wardrobeId}/items/{itemId}`
    : `${options.method} /wardrobes/{wardrobeId}/items`;

  const queryEntries = Object.entries(options.query ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  const rawQueryString = queryEntries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

  return {
    version: '2.0',
    routeKey,
    rawPath,
    rawQueryString,
    headers: { authorization: 'Bearer unused-in-handler' },
    queryStringParameters: options.query,
    body:
      options.rawBody !== undefined
        ? options.rawBody
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined,
    pathParameters: {
      wardrobeId,
      ...(options.itemId ? { itemId: options.itemId } : {}),
    },
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

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Black T-Shirt',
    category: 'TOP',
    subcategory: 'TSHIRT',
    colours: ['BLACK'],
    brand: 'Nike',
    imageKey: OWNER_IMAGE_KEY,
    ...overrides,
  };
}

function mockOwnedWardrobeThen(next: (command: Command) => Promise<unknown>) {
  mockSend.mockImplementation(async (command: Command) => {
    if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
      return { Item: dynamoWardrobe() };
    }
    return next(command);
  });
}

const PROCESSING_QUEUE_URL =
  'https://sqs.eu-west-1.amazonaws.com/123456789012/wardrobe-item-processing-test';

describe('items handler (WARDROBE-11 / WARDROBE-16 / WARDROBE-54)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
    process.env.PROCESSING_QUEUE_URL = PROCESSING_QUEUE_URL;
    process.env.MEDIA_BUCKET_NAME = 'wardrobe-media-test';
    mockSqsSend.mockResolvedValue({ MessageId: 'msg-1' });
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

  describe('POST /wardrobes/{wardrobeId}/items', () => {
    it('creates an item with Flutter ClothingItem shape and PENDING status', async () => {
      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Put') {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'POST', body: createBody() })),
      );

      expect(result.statusCode).toBe(201);
      const body = bodyOf(result) as ClothingItem;
      expect(body).toEqual({
        itemId: expect.stringMatching(/^item_[A-Za-z0-9_-]{12}$/),
        wardrobeId: WARDROBE_ID,
        name: 'Black T-Shirt',
        category: 'TOP',
        subcategory: 'TSHIRT',
        colours: ['BLACK'],
        brand: 'Nike',
        image: { originalKey: OWNER_IMAGE_KEY },
        originalImageUrl: ORIGINAL_IMAGE_URL,
        processingStatus: 'PENDING',
        createdAt: expect.stringMatching(ISO8601),
        updatedAt: expect.stringMatching(ISO8601),
      });
      expect(body).not.toHaveProperty('userId');
      expect(body).not.toHaveProperty('PK');
      expect(body).not.toHaveProperty('SK');
      expect(body).not.toHaveProperty('imageKey');
      expect(body.image).not.toHaveProperty('processedKey');
      expect(body.createdAt).toBe(body.updatedAt);

      const put = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Put',
      )?.[0] as Command;
      expect(put.input.TableName).toBe('wardrobe-app-test');
      expect(put.input.Item).toEqual(
        expect.objectContaining({
          PK: `WARDROBE#${WARDROBE_ID}`,
          SK: `ITEM#${body.itemId}`,
          entityType: 'ITEM',
          userId: OWNER_ID,
          wardrobeId: WARDROBE_ID,
          itemId: body.itemId,
          name: 'Black T-Shirt',
          category: 'TOP',
          originalKey: OWNER_IMAGE_KEY,
          processingStatus: 'PENDING',
        }),
      );
      expect(put.input.Item).not.toHaveProperty('processedKey');
      expect(put.input.Item).not.toHaveProperty('originalImageUrl');
      expect(put.input.Item).not.toHaveProperty('processedImageUrl');
    });

    it('enqueues PROCESS_WARDROBE_ITEM after writing Dynamo', async () => {
      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Put') {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'POST', body: createBody() })),
      );

      expect(result.statusCode).toBe(201);
      const body = bodyOf(result) as ClothingItem;

      const putOrder = mockSend.mock.invocationCallOrder.find((_, index) => {
        return (mockSend.mock.calls[index][0] as Command)._op === 'Put';
      });
      const sqsOrder = mockSqsSend.mock.invocationCallOrder[0];
      expect(putOrder).toBeDefined();
      expect(sqsOrder).toBeGreaterThan(putOrder as number);

      expect(SendMessageCommand).toHaveBeenCalledWith({
        QueueUrl: PROCESSING_QUEUE_URL,
        MessageBody: JSON.stringify({
          jobType: 'PROCESS_WARDROBE_ITEM',
          userId: OWNER_ID,
          wardrobeId: WARDROBE_ID,
          itemId: body.itemId,
          originalImageKey: OWNER_IMAGE_KEY,
        }),
      });
      expect(mockSqsSend).toHaveBeenCalledTimes(1);
    });

    it('fails the request and rolls back Dynamo when enqueue fails', async () => {
      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Put' || command._op === 'Delete') {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });
      mockSqsSend.mockRejectedValue(new Error('sqs unavailable'));

      const result = asResult(
        await handler(event({ method: 'POST', body: createBody() })),
      );

      expectEnvelope(result, 500, 'INTERNAL_ERROR');
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Put'),
      ).toBe(true);
      expect(
        mockSend.mock.calls.some(
          (call) => (call[0] as Command)._op === 'Delete',
        ),
      ).toBe(true);
    });

    it('ignores body userId and processingStatus from the client', async () => {
      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Put') {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            body: createBody({
              userId: OTHER_ID,
              processingStatus: 'READY',
            }),
          }),
        ),
      );

      expect(result.statusCode).toBe(201);
      const body = bodyOf(result) as ClothingItem;
      expect(body.processingStatus).toBe('PENDING');

      const put = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Put',
      )?.[0] as Command;
      expect(put.input.Item?.userId).toBe(OWNER_ID);
      expect(put.input.Item?.processingStatus).toBe('PENDING');
      expect(put.input.Item?.PK).toBe(`WARDROBE#${WARDROBE_ID}`);

      expect(SendMessageCommand).toHaveBeenCalledWith({
        QueueUrl: PROCESSING_QUEUE_URL,
        MessageBody: JSON.stringify({
          jobType: 'PROCESS_WARDROBE_ITEM',
          userId: OWNER_ID,
          wardrobeId: WARDROBE_ID,
          itemId: body.itemId,
          originalImageKey: OWNER_IMAGE_KEY,
        }),
      });
    });

    it('accepts an owned non-uploads path as imageKey', async () => {
      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Put') {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const ownedKey = `users/${OWNER_ID}/items/item_existing/original.jpg`;
      const result = asResult(
        await handler(
          event({ method: 'POST', body: createBody({ imageKey: ownedKey }) }),
        ),
      );

      expect(result.statusCode).toBe(201);
      const body = bodyOf(result) as ClothingItem;
      expect(body.image).toEqual({ originalKey: ownedKey });
    });

    it('returns 404 WARDROBE_NOT_FOUND when the wardrobe is missing', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(event({ method: 'POST', body: createBody() })),
      );

      expectEnvelope(result, 404, 'WARDROBE_NOT_FOUND');
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Put'),
      ).toBe(false);
      expect(mockSqsSend).not.toHaveBeenCalled();
    });

    it('returns 404 WARDROBE_NOT_FOUND when the wardrobe belongs to another user', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(
          event({ method: 'POST', body: createBody(), sub: OTHER_ID }),
        ),
      );

      expectEnvelope(result, 404, 'WARDROBE_NOT_FOUND');
      const get = mockSend.mock.calls[0][0] as Command;
      expect(get.input.Key).toEqual({
        PK: `USER#${OTHER_ID}`,
        SK: `WARDROBE#${WARDROBE_ID}`,
      });
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Put'),
      ).toBe(false);
      expect(mockSqsSend).not.toHaveBeenCalled();
    });
  });

  describe('GET /wardrobes/{wardrobeId}/items', () => {
    it('lists owner items under an items key', async () => {
      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Query') {
          return {
            Items: [
              dynamoItem(),
              {
                ...dynamoItem(),
                SK: 'OUTFIT#outfit_1',
                entityType: 'OUTFIT',
                itemId: undefined,
              },
            ],
          };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(await handler(event({ method: 'GET' })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ items: [itemDto()] });
      expect((bodyOf(result) as { items: ClothingItem[] }).items[0]).toEqual(
        expect.objectContaining({
          originalImageUrl: ORIGINAL_IMAGE_URL,
          image: { originalKey: OWNER_IMAGE_KEY },
        }),
      );

      const query = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Query',
      )?.[0] as Command;
      expect(query.input.ExpressionAttributeValues).toEqual({
        ':pk': `WARDROBE#${WARDROBE_ID}`,
        ':sk': 'ITEM#',
      });
    });

    it('keeps listing other items when one presign fails', async () => {
      const processed = dynamoItem(OWNER_ID, {
        itemId: 'item_ready00001',
        SK: 'ITEM#item_ready00001',
        processedKey: `users/${OWNER_ID}/items/item_ready00001/processed.png`,
      });
      mockGetSignedUrl.mockImplementation(
        async (_client: unknown, command: { input?: { Key?: string } }) => {
          const key = command.input?.Key ?? '';
          if (key === OWNER_IMAGE_KEY) {
            throw new Error('presign unavailable');
          }
          return key.includes('processed')
            ? PROCESSED_IMAGE_URL
            : ORIGINAL_IMAGE_URL;
        },
      );

      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Query') {
          return { Items: [dynamoItem(), processed] };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(await handler(event({ method: 'GET' })));

      expect(result.statusCode).toBe(200);
      const body = bodyOf(result) as { items: ClothingItem[] };
      expect(body.items).toHaveLength(2);
      const listedWithoutUrl = itemDto();
      delete listedWithoutUrl.originalImageUrl;
      expect(body.items[0]).toEqual(listedWithoutUrl);
      expect(body.items[0]).not.toHaveProperty('originalImageUrl');
      const readyWithoutOriginalUrl = itemDto({
        itemId: 'item_ready00001',
        image: {
          originalKey: OWNER_IMAGE_KEY,
          processedKey: `users/${OWNER_ID}/items/item_ready00001/processed.png`,
        },
        processedImageUrl: PROCESSED_IMAGE_URL,
      });
      delete readyWithoutOriginalUrl.originalImageUrl;
      expect(body.items[1]).toEqual(readyWithoutOriginalUrl);
      expect(body.items[1]).not.toHaveProperty('originalImageUrl');
    });

    it('returns an empty items array when the wardrobe has none', async () => {
      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Query') {
          return { Items: [] };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(await handler(event({ method: 'GET' })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ items: [] });
    });

    it('returns 404 WARDROBE_NOT_FOUND when listing another user wardrobe', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(event({ method: 'GET', sub: OTHER_ID })),
      );

      expectEnvelope(result, 404, 'WARDROBE_NOT_FOUND');
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Query'),
      ).toBe(false);
    });

    it('filters by user category and keeps the Flutter items wrapper', async () => {
      const top = dynamoItem();
      const shoes = dynamoItem(OWNER_ID, {
        itemId: 'item_shoes0001',
        SK: 'ITEM#item_shoes0001',
        category: 'SHOES',
        subcategory: 'SNEAKERS',
        colours: ['WHITE'],
      });

      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Query') {
          return { Items: [top, shoes] };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'GET', query: { category: 'TOP' } })),
      );

      expect(result.statusCode).toBe(200);
      const body = bodyOf(result) as { items: ClothingItem[] };
      expect(body).toEqual({ items: [itemDto()] });
      expect(body).not.toHaveProperty('LastEvaluatedKey');
      expect(body).not.toHaveProperty('nextCursor');
    });

    it('matches category against ai.detectedCategory when the user field differs', async () => {
      const detectedTop = dynamoItem(OWNER_ID, {
        itemId: 'item_ai_top001',
        SK: 'ITEM#item_ai_top001',
        category: 'BOTTOM',
        subcategory: 'JEANS',
        colours: ['BLUE'],
        ai: { detectedCategory: 'TOP', detectedSubcategory: 'TSHIRT' },
      });

      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Query') {
          return { Items: [dynamoItem(), detectedTop] };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'GET', query: { category: 'TOP' } })),
      );

      expect(result.statusCode).toBe(200);
      const body = bodyOf(result) as { items: ClothingItem[] };
      expect(body.items.map((item) => item.itemId)).toEqual([
        ITEM_ID,
        'item_ai_top001',
      ]);
    });

    it('filters by user colours and ai.detectedColours', async () => {
      const userBlack = dynamoItem();
      const aiNavy = dynamoItem(OWNER_ID, {
        itemId: 'item_ai_navy01',
        SK: 'ITEM#item_ai_navy01',
        category: 'TOP',
        colours: ['WHITE'],
        ai: { detectedColours: ['NAVY'] },
      });
      const red = dynamoItem(OWNER_ID, {
        itemId: 'item_red000001',
        SK: 'ITEM#item_red000001',
        colours: ['RED'],
      });

      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Query') {
          return { Items: [userBlack, aiNavy, red] };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const black = asResult(
        await handler(event({ method: 'GET', query: { colour: 'BLACK' } })),
      );
      expect(black.statusCode).toBe(200);
      expect(
        (bodyOf(black) as { items: ClothingItem[] }).items.map((item) => item.itemId),
      ).toEqual([ITEM_ID]);

      const navy = asResult(
        await handler(event({ method: 'GET', query: { colour: 'NAVY' } })),
      );
      expect(navy.statusCode).toBe(200);
      expect(
        (bodyOf(navy) as { items: ClothingItem[] }).items.map((item) => item.itemId),
      ).toEqual(['item_ai_navy01']);
    });

    it('ANDs category, colour, and subcategory filters', async () => {
      const match = dynamoItem();
      const wrongColour = dynamoItem(OWNER_ID, {
        itemId: 'item_white0001',
        SK: 'ITEM#item_white0001',
        colours: ['WHITE'],
      });
      const aiMatch = dynamoItem(OWNER_ID, {
        itemId: 'item_ai_and001',
        SK: 'ITEM#item_ai_and001',
        category: 'BOTTOM',
        subcategory: 'JEANS',
        colours: ['BLUE'],
        ai: {
          detectedCategory: 'TOP',
          detectedSubcategory: 'TSHIRT',
          detectedColours: ['BLACK'],
        },
      });

      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Query') {
          return { Items: [match, wrongColour, aiMatch] };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'GET',
            query: { category: 'TOP', colour: 'BLACK', subcategory: 'TSHIRT' },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(
        (bodyOf(result) as { items: ClothingItem[] }).items.map((item) => item.itemId),
      ).toEqual([ITEM_ID, 'item_ai_and001']);
    });

    it('returns an empty items array when filters match nothing', async () => {
      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Query') {
          return { Items: [dynamoItem()] };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'GET', query: { colour: 'GOLD' } })),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ items: [] });
    });

    it('ignores a query userId and still lists only token-owned items', async () => {
      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Query') {
          return {
            Items: [
              dynamoItem(),
              dynamoItem(OTHER_ID, {
                itemId: 'item_other0001',
                SK: 'ITEM#item_other0001',
              }),
            ],
          };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'GET',
            query: { userId: OTHER_ID, category: 'TOP' },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ items: [itemDto()] });
    });

    it.each([
      ['category', { category: 'HAT' }, 'category must be one of: TOP, BOTTOM, DRESS, OUTERWEAR, SHOES, ACCESSORY, BAG.'],
      [
        'colour',
        { colour: 'TURQUOISE' },
        'colour must be one of: BLACK, WHITE, GREY, RED, BLUE, GREEN, YELLOW, ORANGE, PINK, PURPLE, BROWN, BEIGE, NAVY, CREAM, GOLD, SILVER, BURGUNDY, KHAKI, TEAL, OLIVE, MULTICOLOUR.',
      ],
      ['subcategory', { subcategory: 'CAP' }, expect.stringMatching(/^subcategory must be one of:/)],
    ])(
      'returns 400 VALIDATION_ERROR for an invalid %s token before querying items',
      async (_label, query, message) => {
        const result = asResult(await handler(event({ method: 'GET', query })));

        expect(result.statusCode).toBe(400);
        expect(bodyOf(result)).toEqual({
          error: { code: 'VALIDATION_ERROR', message },
        });
        expect(mockSend).not.toHaveBeenCalled();
      },
    );
  });

  describe('GET /wardrobes/{wardrobeId}/items/{itemId}', () => {
    it('returns the owned ClothingItem DTO', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
          return { Item: dynamoWardrobe() };
        }
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('ITEM#')) {
          return { Item: dynamoItem() };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'GET', itemId: ITEM_ID })),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual(itemDto());

      const itemGet = mockSend.mock.calls.find(
        (call) =>
          (call[0] as Command)._op === 'Get' &&
          (call[0] as Command).input.Key?.SK === `ITEM#${ITEM_ID}`,
      )?.[0] as Command;
      expect(itemGet.input.Key).toEqual({
        PK: `WARDROBE#${WARDROBE_ID}`,
        SK: `ITEM#${ITEM_ID}`,
      });
    });

    it('includes processedKey on the Flutter image object when stored', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
          return { Item: dynamoWardrobe() };
        }
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('ITEM#')) {
          return {
            Item: dynamoItem(OWNER_ID, {
              processedKey: OWNER_PROCESSED_KEY,
            }),
          };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'GET', itemId: ITEM_ID })),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual(
        itemDto({
          image: {
            originalKey: OWNER_IMAGE_KEY,
            processedKey: OWNER_PROCESSED_KEY,
          },
          processedImageUrl: PROCESSED_IMAGE_URL,
        }),
      );
    });

    it('includes originalImageUrl while PROCESSING and both URLs when processed', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
          return { Item: dynamoWardrobe() };
        }
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('ITEM#')) {
          return {
            Item: dynamoItem(OWNER_ID, { processingStatus: 'PROCESSING' }),
          };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const processing = asResult(
        await handler(event({ method: 'GET', itemId: ITEM_ID })),
      );

      expect(processing.statusCode).toBe(200);
      expect(bodyOf(processing)).toEqual(
        itemDto({
          processingStatus: 'PROCESSING',
          originalImageUrl: ORIGINAL_IMAGE_URL,
        }),
      );
      expect(bodyOf(processing)).not.toHaveProperty('processedImageUrl');
    });

    it('omits image URLs and still returns 200 when presign fails', async () => {
      mockGetSignedUrl.mockRejectedValue(new Error('presign unavailable'));
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
          return { Item: dynamoWardrobe() };
        }
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('ITEM#')) {
          return {
            Item: dynamoItem(OWNER_ID, { processedKey: OWNER_PROCESSED_KEY }),
          };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'GET', itemId: ITEM_ID })),
      );

      expect(result.statusCode).toBe(200);
      const body = bodyOf(result) as ClothingItem;
      expect(body.image).toEqual({
        originalKey: OWNER_IMAGE_KEY,
        processedKey: OWNER_PROCESSED_KEY,
      });
      expect(body).not.toHaveProperty('originalImageUrl');
      expect(body).not.toHaveProperty('processedImageUrl');
      expect(body.itemId).toBe(ITEM_ID);
    });

    it('returns 404 ITEM_NOT_FOUND when the item is missing', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
          return { Item: dynamoWardrobe() };
        }
        return {};
      });

      const result = asResult(
        await handler(event({ method: 'GET', itemId: ITEM_ID })),
      );

      expectEnvelope(result, 404, 'ITEM_NOT_FOUND');
    });

    it('returns 404 WARDROBE_NOT_FOUND before looking up the item', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(event({ method: 'GET', itemId: ITEM_ID, sub: OTHER_ID })),
      );

      expectEnvelope(result, 404, 'WARDROBE_NOT_FOUND');
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('returns 404 ITEM_NOT_FOUND when the stored item is not an ITEM', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
          return { Item: dynamoWardrobe() };
        }
        return { Item: dynamoItem(OWNER_ID, { entityType: 'OUTFIT' }) };
      });

      const result = asResult(
        await handler(event({ method: 'GET', itemId: ITEM_ID })),
      );

      expectEnvelope(result, 404, 'ITEM_NOT_FOUND');
    });
  });

  describe('PATCH /wardrobes/{wardrobeId}/items/{itemId}', () => {
    it('updates mutable fields for the owner and refreshes updatedAt', async () => {
      const existing = dynamoItem();
      const updated = {
        ...existing,
        name: 'White Shirt',
        category: 'TOP',
        brand: 'Uniqlo',
        updatedAt: '2026-09-04T10:00:00.000Z',
      };

      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
          return { Item: dynamoWardrobe() };
        }
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('ITEM#')) {
          return { Item: existing };
        }
        if (command._op === 'Update') {
          return { Attributes: updated };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'PATCH',
            itemId: ITEM_ID,
            body: { name: '  White Shirt  ', brand: 'Uniqlo' },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual(
        itemDto({
          name: 'White Shirt',
          brand: 'Uniqlo',
          updatedAt: '2026-09-04T10:00:00.000Z',
        }),
      );

      const update = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Update',
      )?.[0] as Command;
      expect(update.input.Key).toEqual({
        PK: `WARDROBE#${WARDROBE_ID}`,
        SK: `ITEM#${ITEM_ID}`,
      });
      expect(update.input.ExpressionAttributeValues).toEqual(
        expect.objectContaining({
          ':name': 'White Shirt',
          ':brand': 'Uniqlo',
          ':updatedAt': expect.stringMatching(ISO8601),
        }),
      );
    });

    it('returns 404 ITEM_NOT_FOUND when patching a missing item', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
          return { Item: dynamoWardrobe() };
        }
        return {};
      });

      const result = asResult(
        await handler(
          event({
            method: 'PATCH',
            itemId: ITEM_ID,
            body: { name: 'Stolen' },
          }),
        ),
      );

      expectEnvelope(result, 404, 'ITEM_NOT_FOUND');
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Update'),
      ).toBe(false);
    });

    it('returns 404 WARDROBE_NOT_FOUND when patching another user wardrobe', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(
          event({
            method: 'PATCH',
            itemId: ITEM_ID,
            body: { name: 'Stolen', userId: OWNER_ID },
            sub: OTHER_ID,
          }),
        ),
      );

      expectEnvelope(result, 404, 'WARDROBE_NOT_FOUND');
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Update'),
      ).toBe(false);
    });
  });

  describe('DELETE /wardrobes/{wardrobeId}/items/{itemId}', () => {
    it('deletes an owned item and returns 204', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
          return { Item: dynamoWardrobe() };
        }
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('ITEM#')) {
          return { Item: dynamoItem() };
        }
        if (command._op === 'Delete') {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'DELETE', itemId: ITEM_ID })),
      );

      expect(result.statusCode).toBe(204);
      expect(result.body).toBe('');

      const del = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Delete',
      )?.[0] as Command;
      expect(del.input.Key).toEqual({
        PK: `WARDROBE#${WARDROBE_ID}`,
        SK: `ITEM#${ITEM_ID}`,
      });
    });

    it('returns 404 ITEM_NOT_FOUND when deleting a missing item', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
          return { Item: dynamoWardrobe() };
        }
        return {};
      });

      const result = asResult(
        await handler(event({ method: 'DELETE', itemId: ITEM_ID })),
      );

      expectEnvelope(result, 404, 'ITEM_NOT_FOUND');
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Delete'),
      ).toBe(false);
    });
  });

  describe('authentication', () => {
    it('returns 401 UNAUTHENTICATED when the authorizer context is missing', async () => {
      const result = asResult(
        await handler(event({ method: 'GET', sub: null })),
      );

      expectEnvelope(result, 401, 'UNAUTHENTICATED');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does not treat a body userId as authenticated identity', async () => {
      const result = asResult(
        await handler(
          event({
            method: 'POST',
            body: createBody({ userId: OTHER_ID }),
            sub: null,
          }),
        ),
      );

      expectEnvelope(result, 401, 'UNAUTHENTICATED');
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it.each([
      ['missing name', { category: 'TOP', imageKey: OWNER_IMAGE_KEY }, 'name must be a string.'],
      ['non-string name', { name: 12, category: 'TOP', imageKey: OWNER_IMAGE_KEY }, 'name must be a string.'],
      ['blank name', { name: '   ', category: 'TOP', imageKey: OWNER_IMAGE_KEY }, 'name is required.'],
      [
        'invalid category',
        { name: 'Shirt', category: 'HAT', imageKey: OWNER_IMAGE_KEY },
        'category must be one of: TOP, BOTTOM, DRESS, OUTERWEAR, SHOES, ACCESSORY, BAG.',
      ],
      [
        'missing imageKey',
        { name: 'Shirt', category: 'TOP' },
        'imageKey must be a string.',
      ],
      [
        'cross-user imageKey',
        {
          name: 'Shirt',
          category: 'TOP',
          imageKey: `users/${OTHER_ID}/uploads/stolen.jpg`,
        },
        'imageKey must belong to the authenticated user.',
      ],
      [
        'path-traversal imageKey',
        {
          name: 'Shirt',
          category: 'TOP',
          imageKey: `users/${OWNER_ID}/uploads/../secret.jpg`,
        },
        'imageKey is not a valid object key.',
      ],
      [
        'non-array colours',
        {
          name: 'Shirt',
          category: 'TOP',
          imageKey: OWNER_IMAGE_KEY,
          colours: 'BLACK',
        },
        'colours must be an array of strings.',
      ],
    ])('returns 400 VALIDATION_ERROR for %s on create', async (_label, body, message) => {
      mockOwnedWardrobeThen(async () => {
        throw new Error('DynamoDB should not be written on validation failure');
      });

      const result = asResult(await handler(event({ method: 'POST', body })));

      expect(result.statusCode).toBe(400);
      expect(bodyOf(result)).toEqual({
        error: { code: 'VALIDATION_ERROR', message },
      });
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Put'),
      ).toBe(false);
      expect(mockSqsSend).not.toHaveBeenCalled();
    });

    it('returns 400 VALIDATION_ERROR when the create body is missing', async () => {
      mockOwnedWardrobeThen(async () => {
        throw new Error('should not write');
      });

      const result = asResult(await handler(event({ method: 'POST' })));

      expect(result.statusCode).toBe(400);
      expect(bodyOf(result)).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request body is required.',
        },
      });
    });

    it('returns 400 VALIDATION_ERROR for invalid JSON', async () => {
      mockOwnedWardrobeThen(async () => {
        throw new Error('should not write');
      });

      const result = asResult(
        await handler(event({ method: 'POST', rawBody: '{not-json' })),
      );

      expect(result.statusCode).toBe(400);
      expect(bodyOf(result)).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request body must be valid JSON.',
        },
      });
    });

    it('returns 400 VALIDATION_ERROR when patch has no mutable fields', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
          return { Item: dynamoWardrobe() };
        }
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('ITEM#')) {
          return { Item: dynamoItem() };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'PATCH',
            itemId: ITEM_ID,
            body: { userId: OTHER_ID, processingStatus: 'FAILED' },
          }),
        ),
      );

      expect(result.statusCode).toBe(400);
      expect(bodyOf(result)).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'At least one field is required.',
        },
      });
    });
  });

  describe('shared error envelope', () => {
    it('wraps unexpected DynamoDB failures as INTERNAL_ERROR', async () => {
      mockSend.mockRejectedValue(new Error('boom'));

      const result = asResult(await handler(event({ method: 'GET' })));

      expect(result.statusCode).toBe(500);
      expect(bodyOf(result)).toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred.',
        },
      });
    });
  });
});
