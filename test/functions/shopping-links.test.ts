import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DynamoItem, HomeShoppingLinksResponse, ShoppingLinksItemResult } from '../../src/shared/types';
import { ShoppingCacheEntry, ShoppingCacheStore } from '../../src/functions/shopping-links/cache';
import { KeywordExtractor } from '../../src/functions/shopping-links/keywords';
import { ShoppingSerpClient } from '../../src/functions/shopping-links/serp';

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

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({})),
  GetObjectCommand: jest.fn(),
  PutObjectCommand: jest.fn(),
  ListObjectsV2Command: jest.fn(),
  DeleteObjectsCommand: jest.fn(),
}));

import { handleShoppingLinks, handler } from '../../src/functions/shopping-links/handler';
import { lookupShoppingCacheKey } from '../../src/functions/shopping-links/cache';
import { dynamoEntitlement, isEntitlementGet } from '../helpers/entitlements';
import {
  DEFAULT_OPENAI_SHOPPING_ENDPOINT,
  DEFAULT_OPENAI_SHOPPING_MODEL,
  createOpenAiKeywordExtractor,
} from '../../src/functions/shopping-links/keywords';
import {
  DEFAULT_BRIGHT_DATA_ENDPOINT,
  createBrightDataSerpClient,
} from '../../src/functions/shopping-links/serp';

const OWNER_ID = 'firebase-uid-owner';
const OTHER_ID = 'firebase-uid-other';
const WARDROBE_ID = 'wd_abc123xyz0';
const ITEM_ID = 'item_xyz123abcd';

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

function dynamoClothingItem(
  itemId = ITEM_ID,
  overrides: Partial<DynamoItem> = {},
): DynamoItem {
  return {
    PK: `WARDROBE#${WARDROBE_ID}`,
    SK: `ITEM#${itemId}`,
    entityType: 'ITEM',
    userId: OWNER_ID,
    wardrobeId: WARDROBE_ID,
    itemId,
    name: 'Black T-Shirt',
    category: 'TOP',
    originalKey: `users/${OWNER_ID}/uploads/photo.jpg`,
    processingStatus: 'READY',
    createdAt: '2026-09-03T18:45:00.000Z',
    updatedAt: '2026-09-03T18:45:00.000Z',
    ...overrides,
  };
}

function event(options: {
  path?: 'item' | 'home';
  method?: string;
  wardrobeId?: string;
  itemId?: string;
  sub?: string | null;
  query?: Record<string, string | undefined>;
} = {}): APIGatewayProxyEventV2 {
  const method = options.method ?? 'GET';
  const authorizer =
    options.sub === null
      ? undefined
      : {
          lambda: { sub: options.sub ?? OWNER_ID },
        };

  if (options.path === 'home') {
    const rawPath = '/shopping-links';
    const routeKey = `${method} /shopping-links`;
    const query = options.query ?? {};
    const rawQueryString = Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    return {
      version: '2.0',
      routeKey,
      rawPath,
      rawQueryString,
      headers: { authorization: 'Bearer unused-in-handler' },
      queryStringParameters: Object.keys(query).length > 0 ? query : undefined,
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

  const wardrobeId = options.wardrobeId ?? WARDROBE_ID;
  const itemId = options.itemId ?? ITEM_ID;
  const rawPath = `/wardrobes/${wardrobeId}/items/${itemId}/shopping-links`;
  const routeKey = `${method} /wardrobes/{wardrobeId}/items/{itemId}/shopping-links`;
  const query = options.query ?? {};
  return {
    version: '2.0',
    routeKey,
    rawPath,
    rawQueryString: '',
    headers: { authorization: 'Bearer unused-in-handler' },
    pathParameters: { wardrobeId, itemId },
    queryStringParameters: Object.keys(query).length > 0 ? query : undefined,
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

function mockOwnedItem(item: DynamoItem = dynamoClothingItem()) {
  mockSend.mockImplementation(async (command: Command) => {
    if (isEntitlementGet(command)) {
      throw new Error('shopping-links must not read ENTITLEMENT');
    }
    if (command._op === 'Get' && command.input.Key?.SK === `WARDROBE#${WARDROBE_ID}`) {
      return { Item: dynamoWardrobe() };
    }
    if (command._op === 'Get' && command.input.Key?.SK === `ITEM#${ITEM_ID}`) {
      return { Item: item };
    }
    if (command._op === 'Get' && command.input.Key?.SK?.startsWith('SHOPPING#')) {
      return {};
    }
    if (command._op === 'Put') {
      return {};
    }
    throw new Error(`unexpected op ${command._op} ${command.input.Key?.SK}`);
  });
}

function happyVendors() {
  const keywords: KeywordExtractor = {
    extract: jest.fn(async () => ['black nike t-shirt']),
  };
  const serp: ShoppingSerpClient = {
    search: jest.fn(async () => [
      {
        title: 'Nike Club Tee',
        url: 'https://www.nike.com/tee',
        merchant: 'Nike',
        price: '£24.99',
        currency: 'GBP',
        imageUrl: 'https://img.example/tee.jpg',
      },
    ]),
  };
  const cache = memoryCache();
  const getImage = jest.fn(async () => ({
    bytes: Buffer.from('jpeg-bytes'),
    contentType: 'image/jpeg',
  }));
  return { keywords, serp, cache, getImage };
}

function memoryCache(seed: ShoppingCacheEntry[] = []): ShoppingCacheStore {
  const rows = new Map(seed.map((entry) => [`${entry.userId}:${entry.itemId}`, entry]));
  return {
    async read(userId, itemId) {
      return rows.get(`${userId}:${itemId}`);
    },
    async write(entry) {
      rows.set(`${entry.userId}:${entry.itemId}`, entry);
    },
  };
}

describe('shopping-links handler (WARDROBE-96)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
    process.env.MEDIA_BUCKET_NAME = 'wardrobe-media-test';
  });

  afterEach(() => {
    delete process.env.TABLE_NAME;
    delete process.env.MEDIA_BUCKET_NAME;
  });

  describe('GET /wardrobes/{wardrobeId}/items/{itemId}/shopping-links', () => {
    it('maps OpenAI keywords and Bright Data products onto the Flutter DTO', async () => {
      mockOwnedItem();
      const deps = happyVendors();
      const result = asResult(await handleShoppingLinks(event(), deps));

      expect(result.statusCode).toBe(200);
      const body = bodyOf(result) as ShoppingLinksItemResult;
      expect(body).toEqual({
        itemId: ITEM_ID,
        wardrobeId: WARDROBE_ID,
        keywords: ['black nike t-shirt'],
        cached: false,
        links: [
          {
            title: 'Nike Club Tee',
            url: 'https://www.nike.com/tee',
            merchant: 'Nike',
            price: '£24.99',
            currency: 'GBP',
            imageUrl: 'https://img.example/tee.jpg',
          },
        ],
      });
      expect(JSON.stringify(body)).not.toContain('null');
      expect(deps.keywords.extract).toHaveBeenCalled();
      expect(deps.serp.search).toHaveBeenCalled();
    });

    it('allows a Free user (does not read entitlements)', async () => {
      mockOwnedItem();
      const result = asResult(await handleShoppingLinks(event(), happyVendors()));
      expect(result.statusCode).toBe(200);
      expect(
        mockSend.mock.calls.some((call) => isEntitlementGet(call[0] as Command)),
      ).toBe(false);
      expect(dynamoEntitlement(OWNER_ID, 'FREE').tier).toBe('FREE');
    });

    it('returns cached: true on a fresh cache hit and skips vendors', async () => {
      mockOwnedItem();
      const cached: ShoppingCacheEntry = {
        userId: OWNER_ID,
        itemId: ITEM_ID,
        wardrobeId: WARDROBE_ID,
        cacheKey: '',
        keywords: ['cached phrase'],
        links: [{ title: 'Cached Tee', url: 'https://cached.example' }],
        createdAt: '2026-09-16T00:00:00.000Z',
        updatedAt: '2026-09-16T00:00:00.000Z',
        ttl: Math.floor(Date.now() / 1000) + 3600,
      };
      cached.cacheKey = lookupShoppingCacheKey(dynamoClothingItem(), OWNER_ID);

      const keywords: KeywordExtractor = { extract: jest.fn() };
      const serp: ShoppingSerpClient = { search: jest.fn() };
      const result = asResult(
        await handleShoppingLinks(event(), {
          keywords,
          serp,
          cache: memoryCache([cached]),
        }),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({
        itemId: ITEM_ID,
        wardrobeId: WARDROBE_ID,
        keywords: ['cached phrase'],
        cached: true,
        links: [{ title: 'Cached Tee', url: 'https://cached.example' }],
      });
      expect(keywords.extract).not.toHaveBeenCalled();
      expect(serp.search).not.toHaveBeenCalled();
    });

    it('soft-fails to 200 with empty links when upstream is unavailable', async () => {
      mockOwnedItem();
      const keywords: KeywordExtractor = {
        extract: jest.fn(async () => {
          throw new Error('OpenAI timeout');
        }),
      };
      const result = asResult(
        await handleShoppingLinks(event(), {
          keywords,
          serp: { search: jest.fn() },
          cache: memoryCache(),
        }),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({
        itemId: ITEM_ID,
        wardrobeId: WARDROBE_ID,
        keywords: [],
        cached: false,
        links: [],
        warning: {
          code: 'SHOPPING_UPSTREAM_UNAVAILABLE',
          message: 'Shopping links are temporarily unavailable.',
        },
      });
    });

    it('soft-fails HTML SERP bodies and logs status, content-type, and a truncated snippet (WARDROBE-98)', async () => {
      mockOwnedItem();
      const logs: Array<Record<string, unknown>> = [];
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation((line: string) => {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      });

      const html = '<!DOCTYPE html><html><body>Google Shopping captcha</body></html>';
      const serp = createBrightDataSerpClient({
        fetchSecret: async () => ({
          apiToken: 'brd-token-secret-value',
          zone: 'serp_api1',
          endpoint: DEFAULT_BRIGHT_DATA_ENDPOINT,
          country: 'gb',
          language: 'en',
        }),
        httpPost: async () => ({
          ok: true,
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          text: async () => html,
        }),
      });

      try {
        const result = asResult(
          await handleShoppingLinks(event(), {
            keywords: { extract: async () => ['black tee'] },
            serp,
            cache: memoryCache(),
            getImage: async () => ({
              bytes: Buffer.from('jpeg-bytes'),
              contentType: 'image/jpeg',
            }),
          }),
        );

        expect(result.statusCode).toBe(200);
        expect(bodyOf(result)).toEqual({
          itemId: ITEM_ID,
          wardrobeId: WARDROBE_ID,
          keywords: [],
          cached: false,
          links: [],
          warning: {
            code: 'SHOPPING_UPSTREAM_UNAVAILABLE',
            message: 'Shopping links are temporarily unavailable.',
          },
        });

        const warn = logs.find(
          (entry) => entry.message === 'Shopping-links upstream unavailable',
        );
        expect(warn).toMatchObject({
          level: 'WARN',
          itemId: ITEM_ID,
          error: 'Bright Data SERP returned a non-JSON body',
          errorName: 'BrightDataSerpError',
          status: 200,
          contentType: 'text/html; charset=utf-8',
          bodySnippet: expect.stringContaining('<!DOCTYPE html>'),
        });
        expect(JSON.stringify(warn)).not.toContain('brd-token-secret-value');
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('logs timeout step and model when OpenAI aborts', async () => {
      mockOwnedItem();
      const logs: Array<Record<string, unknown>> = [];
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation((line: string) => {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      });
      const abort = new Error('This operation was aborted');
      abort.name = 'AbortError';

      try {
        const result = asResult(
          await handleShoppingLinks(event(), {
            keywords: createOpenAiKeywordExtractor({
              fetchSecret: async () => ({
                apiKey: 'sk-test',
                model: DEFAULT_OPENAI_SHOPPING_MODEL,
                endpoint: DEFAULT_OPENAI_SHOPPING_ENDPOINT,
              }),
              httpPost: async () => {
                throw abort;
              },
            }),
            cache: memoryCache(),
            getImage: async () => ({
              bytes: Buffer.from('jpeg-bytes'),
              contentType: 'image/jpeg',
            }),
          }),
        );

        expect(result.statusCode).toBe(200);
        const warn = logs.find(
          (entry) => entry.message === 'Shopping-links upstream unavailable',
        );
        expect(warn).toMatchObject({
          level: 'WARN',
          itemId: ITEM_ID,
          error: expect.stringMatching(
            /OpenAI shopping keywords timed out after \d+ms \(model=gpt-4\.1-mini\)/,
          ),
          errorName: 'UpstreamTimeoutError',
          step: 'OpenAI shopping keywords',
          model: DEFAULT_OPENAI_SHOPPING_MODEL,
          timeoutMs: expect.any(Number),
          cause: 'This operation was aborted',
          causeName: 'AbortError',
        });
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('returns stale cache when upstream fails', async () => {
      mockOwnedItem();
      const stale: ShoppingCacheEntry = {
        userId: OWNER_ID,
        itemId: ITEM_ID,
        wardrobeId: WARDROBE_ID,
        cacheKey: 'stale-mismatch',
        keywords: ['old phrase'],
        links: [{ title: 'Old Tee', url: 'https://old.example' }],
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        ttl: Math.floor(Date.now() / 1000) - 10,
      };
      const result = asResult(
        await handleShoppingLinks(event(), {
          keywords: {
            extract: async () => {
              throw new Error('Bright Data 401');
            },
          },
          cache: memoryCache([stale]),
        }),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({
        itemId: ITEM_ID,
        wardrobeId: WARDROBE_ID,
        keywords: ['old phrase'],
        cached: true,
        links: [{ title: 'Old Tee', url: 'https://old.example' }],
        warning: {
          code: 'SHOPPING_UPSTREAM_UNAVAILABLE',
          message: 'Shopping links are temporarily unavailable.',
        },
      });
    });

    it('returns 404 WARDROBE_NOT_FOUND for a missing wardrobe', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });
      const result = asResult(await handleShoppingLinks(event(), happyVendors()));
      expectEnvelope(result, 404, 'WARDROBE_NOT_FOUND');
    });

    it('returns 404 ITEM_NOT_FOUND for another user\'s item', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK === `WARDROBE#${WARDROBE_ID}`) {
          return { Item: dynamoWardrobe() };
        }
        if (command._op === 'Get' && command.input.Key?.SK === `ITEM#${ITEM_ID}`) {
          return { Item: dynamoClothingItem(ITEM_ID, { userId: OTHER_ID }) };
        }
        return {};
      });
      const result = asResult(await handleShoppingLinks(event(), happyVendors()));
      expectEnvelope(result, 404, 'ITEM_NOT_FOUND');
    });

    it('returns 401 without a Firebase identity', async () => {
      const result = asResult(await handler(event({ sub: null })));
      expectEnvelope(result, 401, 'UNAUTHENTICATED');
    });
  });

  describe('GET /shopping-links query validation', () => {
    it('rejects invalid limit and linksPerItem', async () => {
      const over = asResult(
        await handleShoppingLinks(event({ path: 'home', query: { limit: '11' } })),
      );
      expectEnvelope(over, 400, 'VALIDATION_ERROR');

      const notInt = asResult(
        await handleShoppingLinks(event({ path: 'home', query: { linksPerItem: '8.5' } })),
      );
      expectEnvelope(notInt, 400, 'VALIDATION_ERROR');

      const zero = asResult(
        await handleShoppingLinks(event({ path: 'home', query: { limit: '0' } })),
      );
      expectEnvelope(zero, 400, 'VALIDATION_ERROR');
    });
  });

  describe('GET /shopping-links', () => {
    it('returns recent items across wardrobes for a Free user', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (isEntitlementGet(command)) {
          throw new Error('shopping-links must not read ENTITLEMENT');
        }
        if (command._op === 'Query') {
          const pk = command.input.ExpressionAttributeValues?.[':pk'];
          const sk = command.input.ExpressionAttributeValues?.[':sk'];
          if (pk === `USER#${OWNER_ID}` && sk === 'WARDROBE#') {
            return { Items: [dynamoWardrobe()] };
          }
          if (pk === `WARDROBE#${WARDROBE_ID}` && sk === 'ITEM#') {
            return { Items: [dynamoClothingItem()] };
          }
          return { Items: [] };
        }
        if (command._op === 'Get') {
          return {};
        }
        if (command._op === 'Put') {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handleShoppingLinks(event({ path: 'home' }), happyVendors()),
      );
      expect(result.statusCode).toBe(200);
      const body = bodyOf(result) as HomeShoppingLinksResponse;
      expect(body.items).toHaveLength(1);
      expect(body.items[0].itemId).toBe(ITEM_ID);
      expect(body.items[0].links[0].title).toBe('Nike Club Tee');
    });

    it('returns items: [] when every considered item fails upstream', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Query') {
          const pk = command.input.ExpressionAttributeValues?.[':pk'];
          if (pk === `USER#${OWNER_ID}`) {
            return { Items: [dynamoWardrobe()] };
          }
          if (pk === `WARDROBE#${WARDROBE_ID}`) {
            return { Items: [dynamoClothingItem()] };
          }
          return { Items: [] };
        }
        if (command._op === 'Get' || command._op === 'Put') {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handleShoppingLinks(event({ path: 'home' }), {
          keywords: {
            extract: async () => {
              throw new Error('placeholder secret');
            },
          },
          cache: memoryCache(),
        }),
      );
      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ items: [] });
    });
  });
});
