import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DynamoItem, OutfitRecommendationsResponse } from '../../src/shared/types';
import { OutfitRecommender } from '../../src/functions/recommendations/strategy';

const mockSend = jest.fn();

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

import {
  createDefaultRecommender,
  handleRecommendations,
  handler,
  resolveRecommenderStrategy,
} from '../../src/functions/recommendations/handler';

const OWNER_ID = 'firebase-uid-owner';
const OTHER_ID = 'firebase-uid-other';
const WARDROBE_ID = 'wd_abc123xyz0';
const TOP_ITEM_ID = 'item_top123abcd';
const BOTTOM_ITEM_ID = 'item_bot456efgh';
const SHOES_ITEM_ID = 'item_sho789ijkl';
const DRESS_ITEM_ID = 'item_dre111mnop';
const PENDING_ITEM_ID = 'item_pen222qrst';

interface Command {
  _op: 'Put' | 'Get' | 'Query' | 'Update' | 'Delete';
  input: {
    TableName?: string;
    Item?: DynamoItem;
    Key?: { PK: string; SK: string };
    KeyConditionExpression?: string;
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

function dynamoClothingItem(
  itemId: string,
  overrides: Partial<DynamoItem> = {},
): DynamoItem {
  return {
    PK: `WARDROBE#${WARDROBE_ID}`,
    SK: `ITEM#${itemId}`,
    entityType: 'ITEM',
    userId: OWNER_ID,
    wardrobeId: WARDROBE_ID,
    itemId,
    name: itemId,
    category: 'TOP',
    processingStatus: 'READY',
    createdAt: '2026-09-03T18:45:00.000Z',
    updatedAt: '2026-09-03T18:45:00.000Z',
    ...overrides,
  };
}

function event(options: {
  method?: string;
  wardrobeId?: string;
  sub?: string | null;
  body?: unknown;
} = {}): APIGatewayProxyEventV2 {
  const wardrobeId = options.wardrobeId ?? WARDROBE_ID;
  const method = options.method ?? 'GET';
  const authorizer =
    options.sub === null
      ? undefined
      : {
          lambda: { sub: options.sub ?? OWNER_ID },
        };
  const rawPath = `/wardrobes/${wardrobeId}/recommendations`;
  const routeKey = `${method} /wardrobes/{wardrobeId}/recommendations`;

  return {
    version: '2.0',
    routeKey,
    rawPath,
    rawQueryString: '',
    headers: { authorization: 'Bearer unused-in-handler' },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    pathParameters: { wardrobeId },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'example.com',
      domainPrefix: 'example',
      http: {
        method,
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

function mockOwnedWardrobeThen(next: (command: Command) => Promise<unknown>) {
  mockSend.mockImplementation(async (command: Command) => {
    if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
      return { Item: dynamoWardrobe() };
    }
    return next(command);
  });
}

describe('recommendations handler (WARDROBE-23)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
    delete process.env.RECOMMENDER_STRATEGY;
  });

  afterEach(() => {
    delete process.env.TABLE_NAME;
    delete process.env.RECOMMENDER_STRATEGY;
  });

  describe('GET /wardrobes/{wardrobeId}/recommendations', () => {
    it('returns Flutter-pairable slot+itemId suggestions for the owner', async () => {
      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Query') {
          return {
            Items: [
              dynamoClothingItem(TOP_ITEM_ID, {
                category: 'BOTTOM',
                colours: ['RED'],
                ai: { detectedCategory: 'TOP', detectedColours: ['NAVY'] },
              }),
              dynamoClothingItem(BOTTOM_ITEM_ID, {
                category: 'BOTTOM',
                colours: ['BEIGE'],
              }),
              dynamoClothingItem(SHOES_ITEM_ID, {
                category: 'SHOES',
                colours: ['BROWN'],
              }),
              dynamoClothingItem(PENDING_ITEM_ID, {
                category: 'TOP',
                processingStatus: 'PENDING',
              }),
            ],
          };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(await handler(event()));

      expect(result.statusCode).toBe(200);
      const body = bodyOf(result) as OutfitRecommendationsResponse;
      expect(body.recommendations.length).toBeGreaterThan(0);
      expect(body.recommendations[0].items).toEqual(
        expect.arrayContaining([
          { itemId: TOP_ITEM_ID, slot: 'TOP' },
          { itemId: BOTTOM_ITEM_ID, slot: 'BOTTOM' },
          { itemId: SHOES_ITEM_ID, slot: 'SHOES' },
        ]),
      );
      expect(body.recommendations[0].items.map((item) => item.itemId)).not.toContain(
        PENDING_ITEM_ID,
      );
      expect(body).not.toHaveProperty('outfits');
      expect(body.recommendations[0]).not.toHaveProperty('outfitId');
      expect(body.recommendations[0]).not.toHaveProperty('PK');

      const query = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Query',
      )?.[0] as Command;
      expect(query.input.ExpressionAttributeValues).toEqual({
        ':pk': `WARDROBE#${WARDROBE_ID}`,
        ':sk': 'ITEM#',
      });
      expect(
        mockSend.mock.calls.some((call) =>
          ['Put', 'Update', 'Delete'].includes((call[0] as Command)._op),
        ),
      ).toBe(false);
    });

    it('returns 200 with an empty list when the wardrobe has no READY items', async () => {
      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Query') {
          return { Items: [] };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(await handler(event()));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ recommendations: [] });
    });

    it('returns 200 with an empty list when OpenAI is selected but items are insufficient', async () => {
      process.env.RECOMMENDER_STRATEGY = 'openai';
      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Query') {
          return {
            Items: [dynamoClothingItem(TOP_ITEM_ID, { category: 'TOP' })],
          };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(await handler(event()));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ recommendations: [] });
    });

    it('returns 200 with an empty list when items are insufficient for an outfit', async () => {
      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Query') {
          return {
            Items: [
              dynamoClothingItem(TOP_ITEM_ID, { category: 'TOP' }),
              dynamoClothingItem(PENDING_ITEM_ID, {
                category: 'BOTTOM',
                processingStatus: 'FAILED',
              }),
            ],
          };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(await handler(event()));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ recommendations: [] });
    });

    it('uses an injected strategy so tests never need a live AI model', async () => {
      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Query') {
          return {
            Items: [dynamoClothingItem(DRESS_ITEM_ID, { category: 'DRESS' })],
          };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const recommender: OutfitRecommender = {
        recommend: jest.fn(async () => [
          {
            name: 'Mock look',
            items: [{ itemId: DRESS_ITEM_ID, slot: 'DRESS' as const }],
          },
        ]),
      };

      const result = asResult(await handleRecommendations(event(), { recommender }));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({
        recommendations: [
          {
            name: 'Mock look',
            items: [{ itemId: DRESS_ITEM_ID, slot: 'DRESS' }],
          },
        ],
      });
      expect(recommender.recommend).toHaveBeenCalledWith([
        expect.objectContaining({ itemId: DRESS_ITEM_ID, slot: 'DRESS' }),
      ]);
    });

    it('returns 404 WARDROBE_NOT_FOUND for another user wardrobe', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(await handler(event({ sub: OTHER_ID })));

      expectEnvelope(result, 404, 'WARDROBE_NOT_FOUND');
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Query'),
      ).toBe(false);
    });

    it('ignores a body userId and still uses the token identity', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(event({ sub: OTHER_ID, body: { userId: OWNER_ID } })),
      );

      expectEnvelope(result, 404, 'WARDROBE_NOT_FOUND');
      const get = mockSend.mock.calls[0][0] as Command;
      expect(get.input.Key).toEqual({
        PK: `USER#${OTHER_ID}`,
        SK: `WARDROBE#${WARDROBE_ID}`,
      });
    });
  });

  describe('authentication', () => {
    it('returns 401 UNAUTHENTICATED when the authorizer context is missing', async () => {
      const result = asResult(await handler(event({ sub: null })));

      expectEnvelope(result, 401, 'UNAUTHENTICATED');
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('returns 400 VALIDATION_ERROR for unsupported methods', async () => {
      const result = asResult(await handler(event({ method: 'POST' })));

      expectEnvelope(result, 400, 'VALIDATION_ERROR');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns 400 VALIDATION_ERROR when wardrobeId is missing', async () => {
      const result = asResult(await handler(event({ wardrobeId: '   ' })));

      expectEnvelope(result, 400, 'VALIDATION_ERROR');
    });
  });

  describe('shared error envelope', () => {
    it('wraps unexpected DynamoDB failures as INTERNAL_ERROR', async () => {
      mockSend.mockRejectedValue(new Error('boom'));

      const result = asResult(await handler(event()));

      expect(result.statusCode).toBe(500);
      expect(bodyOf(result)).toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred.',
        },
      });
    });
  });

  describe('createDefaultRecommender', () => {
    it('defaults to the rule-based strategy when the flag is unset', async () => {
      expect(resolveRecommenderStrategy()).toBe('rules');
      const recommender = createDefaultRecommender();
      const recommendations = await recommender.recommend([]);
      expect(recommendations).toEqual([]);
    });

    it('selects OpenAI when RECOMMENDER_STRATEGY=openai without calling a vendor for empty items', async () => {
      process.env.RECOMMENDER_STRATEGY = 'openai';
      expect(resolveRecommenderStrategy()).toBe('openai');
      const recommender = createDefaultRecommender();
      await expect(recommender.recommend([])).resolves.toEqual([]);
    });

    it('selects the HTTP hook when RECOMMENDER_STRATEGY=http', () => {
      process.env.RECOMMENDER_STRATEGY = 'http';
      expect(resolveRecommenderStrategy()).toBe('http');
    });
  });
});
