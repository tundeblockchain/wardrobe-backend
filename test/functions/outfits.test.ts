import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DynamoItem, Outfit } from '../../src/shared/types';

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

import { handler } from '../../src/functions/outfits/handler';

const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OWNER_ID = 'firebase-uid-owner';
const OTHER_ID = 'firebase-uid-other';
const WARDROBE_ID = 'wd_abc123xyz0';
const OTHER_WARDROBE_ID = 'wd_other999zzz';
const OUTFIT_ID = 'outfit_xyz123ab';
const TOP_ITEM_ID = 'item_top123abcd';
const BOTTOM_ITEM_ID = 'item_bot456efgh';
const SHOES_ITEM_ID = 'item_sho789ijkl';
const ACCESSORY_A_ID = 'item_acc111mnop';
const ACCESSORY_B_ID = 'item_acc222qrst';
const FOREIGN_ITEM_ID = 'item_foreign000';

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

function outfitDto(overrides: Partial<Outfit> = {}): Outfit {
  return {
    outfitId: OUTFIT_ID,
    wardrobeId: WARDROBE_ID,
    name: 'Friday Night',
    items: [
      { itemId: TOP_ITEM_ID, slot: 'TOP' },
      { itemId: BOTTOM_ITEM_ID, slot: 'BOTTOM' },
      { itemId: SHOES_ITEM_ID, slot: 'SHOES' },
    ],
    createdAt: '2026-09-03T19:10:00.000Z',
    updatedAt: '2026-09-03T19:10:00.000Z',
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

function dynamoClothingItem(
  itemId: string,
  userId = OWNER_ID,
  wardrobeId = WARDROBE_ID,
): DynamoItem {
  return {
    PK: `WARDROBE#${wardrobeId}`,
    SK: `ITEM#${itemId}`,
    entityType: 'ITEM',
    userId,
    wardrobeId,
    itemId,
    name: itemId,
    category: 'TOP',
    processingStatus: 'READY',
    createdAt: '2026-09-03T18:45:00.000Z',
    updatedAt: '2026-09-03T18:45:00.000Z',
  };
}

function dynamoOutfit(
  userId = OWNER_ID,
  overrides: Partial<DynamoItem> = {},
): DynamoItem {
  const dto = outfitDto();
  return {
    PK: `WARDROBE#${dto.wardrobeId}`,
    SK: `OUTFIT#${dto.outfitId}`,
    entityType: 'OUTFIT',
    userId,
    wardrobeId: dto.wardrobeId,
    outfitId: dto.outfitId,
    name: dto.name,
    items: dto.items,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    ...overrides,
  };
}

function event(options: {
  method: string;
  wardrobeId?: string;
  outfitId?: string;
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

  const rawPath = options.outfitId
    ? `/wardrobes/${wardrobeId}/outfits/${options.outfitId}`
    : `/wardrobes/${wardrobeId}/outfits`;
  const routeKey = options.outfitId
    ? `${options.method} /wardrobes/{wardrobeId}/outfits/{outfitId}`
    : `${options.method} /wardrobes/{wardrobeId}/outfits`;

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
    pathParameters: {
      wardrobeId,
      ...(options.outfitId ? { outfitId: options.outfitId } : {}),
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
    name: 'Friday Night',
    items: [
      { itemId: TOP_ITEM_ID, slot: 'TOP' },
      { itemId: BOTTOM_ITEM_ID, slot: 'BOTTOM' },
      { itemId: SHOES_ITEM_ID, slot: 'SHOES' },
    ],
    ...overrides,
  };
}

const ownedItemIds = new Set([
  TOP_ITEM_ID,
  BOTTOM_ITEM_ID,
  SHOES_ITEM_ID,
  ACCESSORY_A_ID,
  ACCESSORY_B_ID,
]);

function mockOwnedWardrobeThen(next: (command: Command) => Promise<unknown>) {
  mockSend.mockImplementation(async (command: Command) => {
    if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
      return { Item: dynamoWardrobe() };
    }
    return next(command);
  });
}

function mockOwnedItemsThen(next: (command: Command) => Promise<unknown>) {
  mockOwnedWardrobeThen(async (command) => {
    if (command._op === 'Get' && command.input.Key?.SK?.startsWith('ITEM#')) {
      const itemId = command.input.Key.SK.slice('ITEM#'.length);
      if (ownedItemIds.has(itemId)) {
        return { Item: dynamoClothingItem(itemId) };
      }
      return {};
    }
    return next(command);
  });
}

describe('outfits handler (WARDROBE-7)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
  });

  afterEach(() => {
    delete process.env.TABLE_NAME;
  });

  describe('POST /wardrobes/{wardrobeId}/outfits', () => {
    it('creates an outfit with Flutter Outfit shape', async () => {
      mockOwnedItemsThen(async (command) => {
        if (command._op === 'Put') {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'POST', body: createBody() })),
      );

      expect(result.statusCode).toBe(201);
      const body = bodyOf(result) as Outfit;
      expect(body).toEqual({
        outfitId: expect.stringMatching(/^outfit_[A-Za-z0-9_-]{12}$/),
        wardrobeId: WARDROBE_ID,
        name: 'Friday Night',
        items: [
          { itemId: TOP_ITEM_ID, slot: 'TOP' },
          { itemId: BOTTOM_ITEM_ID, slot: 'BOTTOM' },
          { itemId: SHOES_ITEM_ID, slot: 'SHOES' },
        ],
        createdAt: expect.stringMatching(ISO8601),
        updatedAt: expect.stringMatching(ISO8601),
      });
      expect(body).not.toHaveProperty('userId');
      expect(body).not.toHaveProperty('PK');
      expect(body).not.toHaveProperty('SK');
      expect(body).not.toHaveProperty('render');
      expect(body).not.toHaveProperty('image');
      expect(body.createdAt).toBe(body.updatedAt);

      const put = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Put',
      )?.[0] as Command;
      expect(put.input.TableName).toBe('wardrobe-app-test');
      expect(put.input.Item).toEqual(
        expect.objectContaining({
          PK: `WARDROBE#${WARDROBE_ID}`,
          SK: `OUTFIT#${body.outfitId}`,
          entityType: 'OUTFIT',
          userId: OWNER_ID,
          wardrobeId: WARDROBE_ID,
          outfitId: body.outfitId,
          name: 'Friday Night',
          items: body.items,
        }),
      );
    });

    it('allows multiple ACCESSORY slots', async () => {
      mockOwnedItemsThen(async (command) => {
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
              items: [
                { itemId: TOP_ITEM_ID, slot: 'TOP' },
                { itemId: ACCESSORY_A_ID, slot: 'ACCESSORY' },
                { itemId: ACCESSORY_B_ID, slot: 'ACCESSORY' },
              ],
            }),
          }),
        ),
      );

      expect(result.statusCode).toBe(201);
      const body = bodyOf(result) as Outfit;
      expect(body.items).toEqual([
        { itemId: TOP_ITEM_ID, slot: 'TOP' },
        { itemId: ACCESSORY_A_ID, slot: 'ACCESSORY' },
        { itemId: ACCESSORY_B_ID, slot: 'ACCESSORY' },
      ]);
    });

    it('trims the outfit name', async () => {
      mockOwnedItemsThen(async (command) => {
        if (command._op === 'Put') {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({ method: 'POST', body: createBody({ name: '  Friday Night  ' }) }),
        ),
      );

      expect(result.statusCode).toBe(201);
      expect((bodyOf(result) as Outfit).name).toBe('Friday Night');
    });

    it('ignores body userId and does not persist AI/render fields', async () => {
      mockOwnedItemsThen(async (command) => {
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
              render: { imageKey: 'users/x/outfits/render.png' },
            }),
          }),
        ),
      );

      expect(result.statusCode).toBe(201);
      const put = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Put',
      )?.[0] as Command;
      expect(put.input.Item?.userId).toBe(OWNER_ID);
      expect(put.input.Item).not.toHaveProperty('render');
      expect(bodyOf(result)).not.toHaveProperty('render');
    });

    it('returns 404 ITEM_NOT_FOUND for an item that is not in the wardrobe', async () => {
      mockOwnedItemsThen(async () => {
        throw new Error('DynamoDB should not be written for a foreign item');
      });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            body: createBody({
              items: [
                { itemId: TOP_ITEM_ID, slot: 'TOP' },
                { itemId: FOREIGN_ITEM_ID, slot: 'BOTTOM' },
              ],
            }),
          }),
        ),
      );

      expectEnvelope(result, 404, 'ITEM_NOT_FOUND');
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Put'),
      ).toBe(false);
    });

    it('returns 404 ITEM_NOT_FOUND when a referenced item belongs to another wardrobe', async () => {
      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Get' && command.input.Key?.SK === `ITEM#${TOP_ITEM_ID}`) {
          return { Item: dynamoClothingItem(TOP_ITEM_ID) };
        }
        if (command._op === 'Get' && command.input.Key?.SK === `ITEM#${FOREIGN_ITEM_ID}`) {
          return {
            Item: dynamoClothingItem(FOREIGN_ITEM_ID, OWNER_ID, OTHER_WARDROBE_ID),
          };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            body: createBody({
              items: [
                { itemId: TOP_ITEM_ID, slot: 'TOP' },
                { itemId: FOREIGN_ITEM_ID, slot: 'BOTTOM' },
              ],
            }),
          }),
        ),
      );

      expectEnvelope(result, 404, 'ITEM_NOT_FOUND');
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Put'),
      ).toBe(false);
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
    });
  });

  describe('GET /wardrobes/{wardrobeId}/outfits', () => {
    it('lists owner outfits under an outfits key', async () => {
      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Query') {
          return {
            Items: [
              dynamoOutfit(),
              {
                ...dynamoOutfit(),
                SK: 'ITEM#item_1',
                entityType: 'ITEM',
                outfitId: undefined,
              },
            ],
          };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(await handler(event({ method: 'GET' })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ outfits: [outfitDto()] });

      const query = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Query',
      )?.[0] as Command;
      expect(query.input.ExpressionAttributeValues).toEqual({
        ':pk': `WARDROBE#${WARDROBE_ID}`,
        ':sk': 'OUTFIT#',
      });
    });

    it('returns an empty outfits array when the wardrobe has none', async () => {
      mockOwnedWardrobeThen(async (command) => {
        if (command._op === 'Query') {
          return { Items: [] };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(await handler(event({ method: 'GET' })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ outfits: [] });
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
  });

  describe('GET /wardrobes/{wardrobeId}/outfits/{outfitId}', () => {
    it('returns the owned Flutter Outfit DTO', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
          return { Item: dynamoWardrobe() };
        }
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('OUTFIT#')) {
          return { Item: dynamoOutfit() };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'GET', outfitId: OUTFIT_ID })),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual(outfitDto());

      const outfitGet = mockSend.mock.calls.find(
        (call) =>
          (call[0] as Command)._op === 'Get' &&
          (call[0] as Command).input.Key?.SK === `OUTFIT#${OUTFIT_ID}`,
      )?.[0] as Command;
      expect(outfitGet.input.Key).toEqual({
        PK: `WARDROBE#${WARDROBE_ID}`,
        SK: `OUTFIT#${OUTFIT_ID}`,
      });
    });

    it('returns 404 OUTFIT_NOT_FOUND when the outfit is missing', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
          return { Item: dynamoWardrobe() };
        }
        return {};
      });

      const result = asResult(
        await handler(event({ method: 'GET', outfitId: OUTFIT_ID })),
      );

      expectEnvelope(result, 404, 'OUTFIT_NOT_FOUND');
    });

    it('returns 404 WARDROBE_NOT_FOUND before looking up the outfit', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(event({ method: 'GET', outfitId: OUTFIT_ID, sub: OTHER_ID })),
      );

      expectEnvelope(result, 404, 'WARDROBE_NOT_FOUND');
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('returns 404 OUTFIT_NOT_FOUND when the stored record is not an OUTFIT', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
          return { Item: dynamoWardrobe() };
        }
        return { Item: dynamoOutfit(OWNER_ID, { entityType: 'ITEM' }) };
      });

      const result = asResult(
        await handler(event({ method: 'GET', outfitId: OUTFIT_ID })),
      );

      expectEnvelope(result, 404, 'OUTFIT_NOT_FOUND');
    });
  });

  describe('PATCH /wardrobes/{wardrobeId}/outfits/{outfitId}', () => {
    it('updates name and items for the owner and refreshes updatedAt', async () => {
      const existing = dynamoOutfit();
      const updatedItems: Outfit['items'] = [
        { itemId: TOP_ITEM_ID, slot: 'TOP' },
        { itemId: ACCESSORY_A_ID, slot: 'ACCESSORY' },
      ];
      const updated = {
        ...existing,
        name: 'Saturday Brunch',
        items: updatedItems,
        updatedAt: '2026-09-04T10:00:00.000Z',
      };

      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
          return { Item: dynamoWardrobe() };
        }
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('OUTFIT#')) {
          return { Item: existing };
        }
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('ITEM#')) {
          const itemId = command.input.Key.SK.slice('ITEM#'.length);
          if (ownedItemIds.has(itemId)) {
            return { Item: dynamoClothingItem(itemId) };
          }
          return {};
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
            outfitId: OUTFIT_ID,
            body: { name: '  Saturday Brunch  ', items: updatedItems },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual(
        outfitDto({
          name: 'Saturday Brunch',
          items: updatedItems,
          updatedAt: '2026-09-04T10:00:00.000Z',
        }),
      );

      const update = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Update',
      )?.[0] as Command;
      expect(update.input.Key).toEqual({
        PK: `WARDROBE#${WARDROBE_ID}`,
        SK: `OUTFIT#${OUTFIT_ID}`,
      });
      expect(update.input.ExpressionAttributeValues).toEqual(
        expect.objectContaining({
          ':name': 'Saturday Brunch',
          ':items': updatedItems,
          ':updatedAt': expect.stringMatching(ISO8601),
        }),
      );
    });

    it('returns 404 OUTFIT_NOT_FOUND when patching a missing outfit', async () => {
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
            outfitId: OUTFIT_ID,
            body: { name: 'Stolen' },
          }),
        ),
      );

      expectEnvelope(result, 404, 'OUTFIT_NOT_FOUND');
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
            outfitId: OUTFIT_ID,
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

    it('returns 404 ITEM_NOT_FOUND when patched items include a foreign item', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
          return { Item: dynamoWardrobe() };
        }
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('OUTFIT#')) {
          return { Item: dynamoOutfit() };
        }
        if (command._op === 'Get' && command.input.Key?.SK === `ITEM#${TOP_ITEM_ID}`) {
          return { Item: dynamoClothingItem(TOP_ITEM_ID) };
        }
        return {};
      });

      const result = asResult(
        await handler(
          event({
            method: 'PATCH',
            outfitId: OUTFIT_ID,
            body: {
              items: [
                { itemId: TOP_ITEM_ID, slot: 'TOP' },
                { itemId: FOREIGN_ITEM_ID, slot: 'BOTTOM' },
              ],
            },
          }),
        ),
      );

      expectEnvelope(result, 404, 'ITEM_NOT_FOUND');
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Update'),
      ).toBe(false);
    });
  });

  describe('DELETE /wardrobes/{wardrobeId}/outfits/{outfitId}', () => {
    it('deletes an owned outfit and returns 204', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
          return { Item: dynamoWardrobe() };
        }
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('OUTFIT#')) {
          return { Item: dynamoOutfit() };
        }
        if (command._op === 'Delete') {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'DELETE', outfitId: OUTFIT_ID })),
      );

      expect(result.statusCode).toBe(204);
      expect(result.body).toBe('');

      const del = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Delete',
      )?.[0] as Command;
      expect(del.input.Key).toEqual({
        PK: `WARDROBE#${WARDROBE_ID}`,
        SK: `OUTFIT#${OUTFIT_ID}`,
      });
    });

    it('returns 404 OUTFIT_NOT_FOUND when deleting a missing outfit', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
          return { Item: dynamoWardrobe() };
        }
        return {};
      });

      const result = asResult(
        await handler(event({ method: 'DELETE', outfitId: OUTFIT_ID })),
      );

      expectEnvelope(result, 404, 'OUTFIT_NOT_FOUND');
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
      ['missing name', { items: [{ itemId: TOP_ITEM_ID, slot: 'TOP' }] }, 'name must be a string.'],
      [
        'blank name',
        { name: '   ', items: [{ itemId: TOP_ITEM_ID, slot: 'TOP' }] },
        'name is required.',
      ],
      [
        'name too long',
        { name: 'a'.repeat(101), items: [{ itemId: TOP_ITEM_ID, slot: 'TOP' }] },
        'name must be 100 characters or fewer.',
      ],
      ['missing items', { name: 'Friday Night' }, 'items must be an array.'],
      [
        'empty items',
        { name: 'Friday Night', items: [] },
        'items must contain at least one item.',
      ],
      [
        'invalid slot',
        { name: 'Friday Night', items: [{ itemId: TOP_ITEM_ID, slot: 'HAT' }] },
        'items[0].slot must be one of: TOP, BOTTOM, DRESS, OUTERWEAR, SHOES, ACCESSORY, BAG.',
      ],
      [
        'duplicate unique slot',
        {
          name: 'Friday Night',
          items: [
            { itemId: TOP_ITEM_ID, slot: 'TOP' },
            { itemId: BOTTOM_ITEM_ID, slot: 'TOP' },
          ],
        },
        'slot TOP can only appear once (ACCESSORY may appear multiple times).',
      ],
      [
        'duplicate itemId',
        {
          name: 'Friday Night',
          items: [
            { itemId: TOP_ITEM_ID, slot: 'TOP' },
            { itemId: TOP_ITEM_ID, slot: 'BOTTOM' },
          ],
        },
        'items must not contain duplicate itemId values.',
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
        if (command._op === 'Get' && command.input.Key?.SK?.startsWith('OUTFIT#')) {
          return { Item: dynamoOutfit() };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'PATCH',
            outfitId: OUTFIT_ID,
            body: { userId: OTHER_ID, render: { imageKey: 'x' } },
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
