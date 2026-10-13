import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DynamoItem, Wardrobe } from '../../src/shared/types';

const mockSend = jest.fn();
const mockS3Send = jest.fn();
const mockGetSignedUrl = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'GetObject',
    input,
  })),
  PutObjectCommand: jest.fn(),
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
  BatchWriteCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'BatchWrite',
    input,
  })),
}));

import { handler } from '../../src/functions/wardrobes/handler';

const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OWNER_ID = 'firebase-uid-owner';
const OTHER_ID = 'firebase-uid-other';
const WARDROBE_ID = 'wd_abc123xyz0';
const OTHER_WARDROBE_ID = 'wd_other000001';
const ITEM_ID = 'item_xyz123abcd';
const OTHER_ITEM_ID = 'item_keep000001';
const OUTFIT_ID = 'outfit_qwerty12';
const OTHER_OUTFIT_ID = 'outfit_keep0001';
const CROSS_OUTFIT_ID = 'outfit_cross001';
const WORN_ON = '2026-09-18';
const SHARE_TOKEN = 'shr_cascade000000000001';
const OTHER_SHARE_TOKEN = 'shr_keep00000000000001';
const COVER_ORIGINAL_KEY = `users/${OWNER_ID}/uploads/cover.jpg`;
const COVER_PROCESSED_KEY = `users/${OWNER_ID}/items/item_first00001/processed.png`;
const WARDROBE_OWN_KEY = `users/${OWNER_ID}/wardrobes/${WARDROBE_ID}/cover.jpg`;
const ITEM_ORIGINAL_KEY = `users/${OWNER_ID}/uploads/photo.jpg`;
const ITEM_PROCESSED_KEY = `users/${OWNER_ID}/items/${ITEM_ID}/processed.png`;
const ITEM_RENDER_KEY = `users/${OWNER_ID}/items/${ITEM_ID}/renders/rnd_1.png`;
const OUTFIT_RENDER_KEY = `users/${OWNER_ID}/outfits/${OUTFIT_ID}/renders/rnd_2.png`;
const CROSS_RENDER_KEY = `users/${OWNER_ID}/outfits/${CROSS_OUTFIT_ID}/renders/rnd_3.png`;
const OTHER_ITEM_ORIGINAL_KEY = `users/${OWNER_ID}/uploads/keep.jpg`;
const OTHER_USER_KEY = `users/${OTHER_ID}/uploads/theirs.jpg`;

const SIGNED_URLS: Record<string, string> = {
  [WARDROBE_OWN_KEY]: 'https://signed.example/wardrobe-cover',
  [COVER_PROCESSED_KEY]: 'https://signed.example/item-processed',
  [COVER_ORIGINAL_KEY]: 'https://signed.example/item-original',
};

function signedUrl(key: string): string {
  return SIGNED_URLS[key] ?? 'https://signed.example/other';
}

interface Command {
  _op: 'Put' | 'Get' | 'Query' | 'Update' | 'Delete' | 'BatchWrite';
  input: {
    TableName?: string;
    Item?: DynamoItem;
    Key?: { PK: string; SK: string };
    KeyConditionExpression?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
    ExclusiveStartKey?: Record<string, unknown>;
    IndexName?: string;
    UpdateExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    RequestItems?: Record<
      string,
      Array<{ DeleteRequest?: { Key?: { PK: string; SK: string } } }>
    >;
  };
}

interface S3Command {
  _op: 'ListObjectsV2' | 'DeleteObjects';
  input: {
    Bucket?: string;
    Prefix?: string;
    ContinuationToken?: string;
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

function wardrobeDto(overrides: Partial<Wardrobe> = {}): Wardrobe {
  return {
    wardrobeId: WARDROBE_ID,
    name: 'Summer Clothes',
    createdAt: '2026-09-03T18:35:00.000Z',
    updatedAt: '2026-09-03T18:35:00.000Z',
    ...overrides,
  };
}

function dynamoWardrobe(
  userId: string,
  overrides: Partial<DynamoItem> = {},
): DynamoItem {
  const dto = wardrobeDto();
  return {
    PK: `USER#${userId}`,
    SK: `WARDROBE#${dto.wardrobeId}`,
    entityType: 'WARDROBE',
    userId,
    wardrobeId: dto.wardrobeId,
    name: dto.name,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    ...overrides,
  };
}

function event(options: {
  method: string;
  wardrobeId?: string;
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
    routeKey: options.wardrobeId
      ? `${options.method} /wardrobes/{wardrobeId}`
      : `${options.method} /wardrobes`,
    rawPath: options.wardrobeId
      ? `/wardrobes/${options.wardrobeId}`
      : '/wardrobes',
    rawQueryString: '',
    headers: { authorization: 'Bearer unused-in-handler' },
    body:
      options.rawBody !== undefined
        ? options.rawBody
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined,
    pathParameters: options.wardrobeId
      ? { wardrobeId: options.wardrobeId }
      : undefined,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'example.com',
      domainPrefix: 'example',
      http: {
        method: options.method,
        path: options.wardrobeId
          ? `/wardrobes/${options.wardrobeId}`
          : '/wardrobes',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'jest',
      },
      requestId: 'req-1',
      routeKey: options.wardrobeId
        ? `${options.method} /wardrobes/{wardrobeId}`
        : `${options.method} /wardrobes`,
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

function dynamoItem(
  userId: string,
  overrides: Partial<DynamoItem> = {},
): DynamoItem {
  const itemId = String(overrides.itemId ?? 'item_first00001');
  return {
    PK: `WARDROBE#${WARDROBE_ID}`,
    SK: `ITEM#${itemId}`,
    entityType: 'ITEM',
    userId,
    wardrobeId: WARDROBE_ID,
    itemId,
    name: 'Black T-Shirt',
    category: 'TOP',
    originalKey: COVER_ORIGINAL_KEY,
    createdAt: '2026-09-03T18:45:00.000Z',
    updatedAt: '2026-09-03T18:45:00.000Z',
    ...overrides,
  };
}

function dynamoOutfit(
  userId: string,
  overrides: Partial<DynamoItem> = {},
): DynamoItem {
  const wardrobeId = String(overrides.wardrobeId ?? WARDROBE_ID);
  const outfitId = String(overrides.outfitId ?? OUTFIT_ID);
  return {
    PK: `WARDROBE#${wardrobeId}`,
    SK: `OUTFIT#${outfitId}`,
    entityType: 'OUTFIT',
    userId,
    wardrobeId,
    outfitId,
    name: 'Friday Night',
    items: [{ itemId: ITEM_ID, slot: 'TOP' }],
    render: { status: 'READY', imageKey: OUTFIT_RENDER_KEY, aiProfileId: 'ap_1' },
    renderHistory: [
      {
        imageKey: OUTFIT_RENDER_KEY,
        createdAt: '2026-09-18T19:00:00.000Z',
        aiProfileId: 'ap_1',
      },
    ],
    createdAt: '2026-09-03T18:50:00.000Z',
    updatedAt: '2026-09-03T18:50:00.000Z',
    ...overrides,
  };
}

function dynamoWornOn(
  userId: string,
  overrides: Partial<DynamoItem> = {},
): DynamoItem {
  const wardrobeId = String(overrides.wardrobeId ?? WARDROBE_ID);
  const outfitId = String(overrides.outfitId ?? OUTFIT_ID);
  const wornOn = String(overrides.wornOn ?? WORN_ON);
  return {
    PK: `WARDROBE#${wardrobeId}`,
    SK: `OUTFIT#${outfitId}#WORN#${wornOn}`,
    entityType: 'WORN_ON',
    userId,
    wardrobeId,
    outfitId,
    wornOn,
    createdAt: '2026-09-18T19:10:00.000Z',
    updatedAt: '2026-09-18T19:10:00.000Z',
    ...overrides,
  };
}

function dynamoShopping(userId: string): DynamoItem {
  return {
    PK: `WARDROBE#${WARDROBE_ID}`,
    SK: `SHOPPING#${ITEM_ID}`,
    entityType: 'SHOPPING_CACHE',
    userId,
    wardrobeId: WARDROBE_ID,
    itemId: ITEM_ID,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
  };
}

function dynamoShare(
  userId: string,
  overrides: Partial<DynamoItem> = {},
): DynamoItem {
  const token = String(overrides.token ?? SHARE_TOKEN);
  return {
    PK: `SHARE#${token}`,
    SK: 'SHARE',
    GSI1PK: `SHARE#USER#${userId}`,
    GSI1SK: `SHARE#${token}`,
    entityType: 'SHARE',
    userId,
    wardrobeId: WARDROBE_ID,
    resourceType: 'ITEM',
    itemId: ITEM_ID,
    token,
    createdAt: '2026-09-19T12:00:00.000Z',
    updatedAt: '2026-09-19T12:00:00.000Z',
    ...overrides,
  };
}

function cascadeItem(userId = OWNER_ID): DynamoItem {
  return dynamoItem(userId, {
    itemId: ITEM_ID,
    originalKey: ITEM_ORIGINAL_KEY,
    processedKey: ITEM_PROCESSED_KEY,
    renderHistory: [
      {
        imageKey: ITEM_RENDER_KEY,
        createdAt: '2026-09-18T18:00:00.000Z',
        aiProfileId: 'ap_1',
      },
    ],
  });
}

function mockListWardrobes(options: {
  wardrobes: DynamoItem[];
  itemsByWardrobe?: Record<string, DynamoItem[]>;
}): void {
  mockSend.mockImplementation(async (command: Command) => {
    if (command._op !== 'Query') {
      throw new Error(`unexpected op ${command._op}`);
    }
    const pk = String(command.input.ExpressionAttributeValues?.[':pk'] ?? '');
    const sk = String(command.input.ExpressionAttributeValues?.[':sk'] ?? '');
    if (pk === `USER#${OWNER_ID}` && sk === 'WARDROBE#') {
      return { Items: options.wardrobes };
    }
    if (pk.startsWith('WARDROBE#') && sk === 'ITEM#') {
      const wardrobeId = pk.slice('WARDROBE#'.length);
      return { Items: options.itemsByWardrobe?.[wardrobeId] ?? [] };
    }
    throw new Error(`unexpected query ${pk} ${sk}`);
  });
}

function mockDeleteCascade(options: {
  wardrobe?: DynamoItem;
  children?: DynamoItem[];
  otherWardrobes?: DynamoItem[];
  otherChildren?: Record<string, DynamoItem[]>;
  shares?: DynamoItem[];
  s3ByPrefix?: Record<string, string[]>;
  paginateChildren?: boolean;
}): void {
  const wardrobe = options.wardrobe ?? dynamoWardrobe(OWNER_ID);
  const children = options.children ?? [];
  const otherWardrobes = options.otherWardrobes ?? [];
  const otherChildren = options.otherChildren ?? {};
  const shares = options.shares ?? [];
  const s3ByPrefix = options.s3ByPrefix ?? {};

  mockSend.mockImplementation(async (command: Command) => {
    if (command._op === 'Get') {
      if (
        command.input.Key?.PK === `USER#${OWNER_ID}` &&
        command.input.Key?.SK === `WARDROBE#${WARDROBE_ID}`
      ) {
        return { Item: wardrobe };
      }
      return {};
    }
    if (command._op === 'Query') {
      const pk = String(command.input.ExpressionAttributeValues?.[':pk'] ?? '');
      const sk = String(command.input.ExpressionAttributeValues?.[':sk'] ?? '');
      if (command.input.IndexName === 'GSI1') {
        return { Items: shares };
      }
      if (pk === `USER#${OWNER_ID}` && sk === 'WARDROBE#') {
        return { Items: [wardrobe, ...otherWardrobes] };
      }
      if (pk === `WARDROBE#${WARDROBE_ID}`) {
        if (options.paginateChildren && children.length > 1) {
          if (!command.input.ExclusiveStartKey) {
            return {
              Items: [children[0]],
              LastEvaluatedKey: {
                PK: children[0].PK,
                SK: children[0].SK,
              },
            };
          }
          return { Items: children.slice(1) };
        }
        return { Items: children };
      }
      if (pk.startsWith('WARDROBE#') && !sk) {
        const wardrobeId = pk.slice('WARDROBE#'.length);
        return { Items: otherChildren[wardrobeId] ?? [] };
      }
      return { Items: [] };
    }
    if (
      command._op === 'BatchWrite' ||
      command._op === 'Delete' ||
      command._op === 'Update'
    ) {
      return { Attributes: {} };
    }
    throw new Error(`unexpected op ${command._op}`);
  });

  mockS3Send.mockImplementation(async (command: S3Command) => {
    if (command._op === 'ListObjectsV2') {
      const prefix = command.input.Prefix ?? '';
      const keys = (s3ByPrefix[prefix] ?? []).filter(
        (key) => key.startsWith(prefix) && key.length > prefix.length,
      );
      return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false };
    }
    if (command._op === 'DeleteObjects') {
      return { Deleted: command.input.Delete?.Objects ?? [] };
    }
    throw new Error(`unexpected S3 op ${command._op}`);
  });
}

function deletedKeys(): Array<{ PK: string; SK: string }> {
  const keys: Array<{ PK: string; SK: string }> = [];
  for (const call of mockSend.mock.calls) {
    const command = call[0] as Command;
    if (command._op === 'Delete' && command.input.Key) {
      keys.push(command.input.Key);
    }
    if (command._op === 'BatchWrite') {
      for (const requests of Object.values(command.input.RequestItems ?? {})) {
        for (const request of requests) {
          const key = request.DeleteRequest?.Key;
          if (key) {
            keys.push(key);
          }
        }
      }
    }
  }
  return keys;
}

function listedS3Prefixes(): string[] {
  return mockS3Send.mock.calls
    .map((call) => call[0] as S3Command)
    .filter((command) => command._op === 'ListObjectsV2')
    .map((command) => command.input.Prefix ?? '');
}

function deletedS3Keys(): string[] {
  const keys: string[] = [];
  for (const call of mockS3Send.mock.calls) {
    const command = call[0] as S3Command;
    if (command._op === 'DeleteObjects') {
      keys.push(
        ...(command.input.Delete?.Objects ?? []).map((object) => object.Key),
      );
    }
  }
  return keys;
}

function outfitUpdates(): Command[] {
  return mockSend.mock.calls
    .map((call) => call[0] as Command)
    .filter((command) => command._op === 'Update');
}

describe('wardrobes handler (WARDROBE-5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
    process.env.MEDIA_BUCKET_NAME = 'wardrobe-media-test';
    mockGetSignedUrl.mockImplementation(
      async (_client: unknown, command: { input?: { Key?: string } }) =>
        signedUrl(command.input?.Key ?? 'missing'),
    );
  });

  afterEach(() => {
    delete process.env.TABLE_NAME;
    delete process.env.MEDIA_BUCKET_NAME;
  });

  describe('POST /wardrobes', () => {
    it('creates a wardrobe for the authenticated user', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            body: { name: '  Summer Clothes  ' },
          }),
        ),
      );

      expect(result.statusCode).toBe(201);
      const body = bodyOf(result) as Wardrobe;
      expect(body).toEqual({
        wardrobeId: expect.stringMatching(/^wd_[A-Za-z0-9_-]{12}$/),
        name: 'Summer Clothes',
        createdAt: expect.stringMatching(ISO8601),
        updatedAt: expect.stringMatching(ISO8601),
      });
      expect(body).not.toHaveProperty('userId');
      expect(body).not.toHaveProperty('PK');
      expect(body).not.toHaveProperty('SK');
      expect(body.createdAt).toBe(body.updatedAt);

      const command = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Put',
      )?.[0] as Command;
      expect(command).toBeDefined();
      expect(command.input.TableName).toBe('wardrobe-app-test');
      expect(command.input.Item).toEqual(
        expect.objectContaining({
          PK: `USER#${OWNER_ID}`,
          SK: `WARDROBE#${body.wardrobeId}`,
          entityType: 'WARDROBE',
          userId: OWNER_ID,
          wardrobeId: body.wardrobeId,
          name: 'Summer Clothes',
        }),
      );
    });

    it('ignores body userId and still owns the wardrobe as the token UID', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            body: { name: 'Holiday Clothes', userId: OTHER_ID },
          }),
        ),
      );

      expect(result.statusCode).toBe(201);
      const command = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Put',
      )?.[0] as Command;
      expect(command.input.Item?.userId).toBe(OWNER_ID);
      expect(command.input.Item?.PK).toBe(`USER#${OWNER_ID}`);
      expect(command.input.Item?.userId).not.toBe(OTHER_ID);
    });

    it('rejects a second wardrobe on Free with ENTITLEMENT_WARDROBE_LIMIT', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
          return {};
        }
        if (command._op === 'Query') {
          return { Items: [dynamoWardrobe(OWNER_ID)] };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'POST', body: { name: 'Second' } })),
      );

      expectEnvelope(result, 403, 'ENTITLEMENT_WARDROBE_LIMIT');
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Put'),
      ).toBe(false);
    });

    it('allows a second wardrobe on Basic', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (
          command._op === 'Query' &&
          command.input.ExpressionAttributeValues?.[':sk'] === 'ENTITLEMENT'
        ) {
          return {
            Items: [
              {
                PK: `USER#${OWNER_ID}`,
                SK: 'ENTITLEMENT',
                entityType: 'ENTITLEMENT',
                userId: OWNER_ID,
                tier: 'BASIC',
                status: 'ACTIVE',
                createdAt: '2026-09-16T00:00:00.000Z',
                updatedAt: '2026-09-16T00:00:00.000Z',
              },
            ],
          };
        }
        if (command._op === 'Put') {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'POST', body: { name: 'Second' } })),
      );

      expect(result.statusCode).toBe(201);
    });
  });

  describe('GET /wardrobes', () => {
    it('lists only the owner wardrobes under a wardrobes key', async () => {
      const owned = dynamoWardrobe(OWNER_ID);
      mockListWardrobes({
        wardrobes: [
          owned,
          {
            ...owned,
            SK: 'WARDROBE#wd_not_a_wardrobe',
            entityType: 'PROFILE',
            wardrobeId: 'wd_not_a_wardrobe',
          },
        ],
      });

      const result = asResult(await handler(event({ method: 'GET' })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({
        wardrobes: [wardrobeDto()],
      });

      const command = mockSend.mock.calls[0][0] as Command;
      expect(command._op).toBe('Query');
      expect(command.input.ExpressionAttributeValues).toEqual({
        ':pk': `USER#${OWNER_ID}`,
        ':sk': 'WARDROBE#',
      });
    });

    it('returns an empty wardrobes array when the owner has none', async () => {
      mockListWardrobes({ wardrobes: [] });

      const result = asResult(await handler(event({ method: 'GET' })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ wardrobes: [] });
    });

    it('adds coverImageUrl from the wardrobe own image without scanning items', async () => {
      mockListWardrobes({
        wardrobes: [
          dynamoWardrobe(OWNER_ID, { coverImageKey: WARDROBE_OWN_KEY }),
        ],
      });

      const result = asResult(await handler(event({ method: 'GET' })));
      const body = bodyOf(result) as { wardrobes: Wardrobe[] };

      expect(result.statusCode).toBe(200);
      expect(body).toEqual({
        wardrobes: [
          wardrobeDto({ coverImageUrl: signedUrl(WARDROBE_OWN_KEY) }),
        ],
      });
      expect(body.wardrobes[0]).toEqual({
        wardrobeId: WARDROBE_ID,
        name: 'Summer Clothes',
        createdAt: '2026-09-03T18:35:00.000Z',
        updatedAt: '2026-09-03T18:35:00.000Z',
        coverImageUrl: signedUrl(WARDROBE_OWN_KEY),
      });
      expect(JSON.stringify(body)).not.toContain('users/');
      expect(body.wardrobes[0].coverImageUrl).not.toBe(WARDROBE_OWN_KEY);
      expect(body.wardrobes[0]).not.toHaveProperty('coverImageKey');
      expect(body.wardrobes[0]).not.toHaveProperty('imageKey');
      expect(body.wardrobes[0]).not.toHaveProperty('originalKey');
      expect(
        mockSend.mock.calls.some((call) => {
          const command = call[0] as Command;
          return (
            command._op === 'Query' &&
            command.input.ExpressionAttributeValues?.[':sk'] === 'ITEM#'
          );
        }),
      ).toBe(false);
    });

    it('falls back to the first item image (earliest createdAt)', async () => {
      const later = dynamoItem(OWNER_ID, {
        itemId: 'item_later00002',
        createdAt: '2026-09-04T10:00:00.000Z',
        originalKey: `users/${OWNER_ID}/uploads/later.jpg`,
      });
      const earlier = dynamoItem(OWNER_ID, {
        itemId: 'item_early00001',
        createdAt: '2026-09-03T08:00:00.000Z',
        processedKey: COVER_PROCESSED_KEY,
        originalKey: COVER_ORIGINAL_KEY,
      });
      mockListWardrobes({
        wardrobes: [dynamoWardrobe(OWNER_ID)],
        itemsByWardrobe: {
          [WARDROBE_ID]: [later, earlier],
        },
      });

      const result = asResult(await handler(event({ method: 'GET' })));
      const body = bodyOf(result) as { wardrobes: Wardrobe[] };

      expect(result.statusCode).toBe(200);
      expect(body.wardrobes[0]).toEqual({
        wardrobeId: WARDROBE_ID,
        name: 'Summer Clothes',
        createdAt: '2026-09-03T18:35:00.000Z',
        updatedAt: '2026-09-03T18:35:00.000Z',
        coverImageUrl: signedUrl(COVER_PROCESSED_KEY),
      });
      expect(JSON.stringify(body)).not.toContain('users/');
      expect(body.wardrobes[0].coverImageUrl).not.toBe(COVER_PROCESSED_KEY);
      expect(body.wardrobes[0].coverImageUrl).not.toBe(COVER_ORIGINAL_KEY);
      expect(body.wardrobes[0]).not.toHaveProperty('image');
      expect(body.wardrobes[0]).not.toHaveProperty('originalKey');
      expect(body.wardrobes[0]).not.toHaveProperty('processedKey');
    });

    it('omits coverImageUrl for an empty wardrobe', async () => {
      mockListWardrobes({
        wardrobes: [dynamoWardrobe(OWNER_ID)],
        itemsByWardrobe: { [WARDROBE_ID]: [] },
      });

      const result = asResult(await handler(event({ method: 'GET' })));
      const body = bodyOf(result) as { wardrobes: Wardrobe[] };

      expect(result.statusCode).toBe(200);
      expect(body).toEqual({
        wardrobes: [wardrobeDto()],
      });
      expect(body.wardrobes[0]).not.toHaveProperty('coverImageUrl');
      expect(Object.keys(body.wardrobes[0]).sort()).toEqual([
        'createdAt',
        'name',
        'updatedAt',
        'wardrobeId',
      ]);
    });

    it('leaves existing list fields unchanged when coverImageUrl is present', async () => {
      mockListWardrobes({
        wardrobes: [dynamoWardrobe(OWNER_ID)],
        itemsByWardrobe: {
          [WARDROBE_ID]: [dynamoItem(OWNER_ID)],
        },
      });

      const result = asResult(await handler(event({ method: 'GET' })));
      const listed = (bodyOf(result) as { wardrobes: Wardrobe[] }).wardrobes[0];
      const { coverImageUrl, ...existing } = listed;

      expect(coverImageUrl).toBe(signedUrl(COVER_ORIGINAL_KEY));
      expect(existing).toEqual(wardrobeDto());
    });
  });

  describe('GET /wardrobes/{wardrobeId}', () => {
    it('returns the owned wardrobe DTO', async () => {
      mockSend.mockResolvedValue({ Item: dynamoWardrobe(OWNER_ID) });

      const result = asResult(
        await handler(event({ method: 'GET', wardrobeId: WARDROBE_ID })),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual(wardrobeDto());

      const command = mockSend.mock.calls[0][0] as Command;
      expect(command._op).toBe('Get');
      expect(command.input.Key).toEqual({
        PK: `USER#${OWNER_ID}`,
        SK: `WARDROBE#${WARDROBE_ID}`,
      });
    });

    it('returns 404 WARDROBE_NOT_FOUND when the wardrobe is missing', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(event({ method: 'GET', wardrobeId: WARDROBE_ID })),
      );

      expectEnvelope(result, 404, 'WARDROBE_NOT_FOUND');
    });

    it('returns 404 WARDROBE_NOT_FOUND when the wardrobe belongs to another user', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(
          event({
            method: 'GET',
            wardrobeId: WARDROBE_ID,
            sub: OTHER_ID,
          }),
        ),
      );

      expectEnvelope(result, 404, 'WARDROBE_NOT_FOUND');
      const command = mockSend.mock.calls[0][0] as Command;
      expect(command.input.Key?.PK).toBe(`USER#${OTHER_ID}`);
    });

    it('returns 404 WARDROBE_NOT_FOUND when the stored item is not a wardrobe', async () => {
      mockSend.mockResolvedValue({
        Item: dynamoWardrobe(OWNER_ID, { entityType: 'PROFILE' }),
      });

      const result = asResult(
        await handler(event({ method: 'GET', wardrobeId: WARDROBE_ID })),
      );

      expectEnvelope(result, 404, 'WARDROBE_NOT_FOUND');
    });
  });

  describe('PATCH /wardrobes/{wardrobeId}', () => {
    it('updates the name for the owner and refreshes updatedAt', async () => {
      const existing = dynamoWardrobe(OWNER_ID);
      const updated = {
        ...existing,
        name: 'Winter Wardrobe',
        updatedAt: '2026-09-04T10:00:00.000Z',
      };

      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
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
            wardrobeId: WARDROBE_ID,
            body: { name: '  Winter Wardrobe  ' },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual(
        wardrobeDto({
          name: 'Winter Wardrobe',
          updatedAt: '2026-09-04T10:00:00.000Z',
        }),
      );

      const update = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Update',
      )?.[0] as Command;
      expect(update.input.Key).toEqual({
        PK: `USER#${OWNER_ID}`,
        SK: `WARDROBE#${WARDROBE_ID}`,
      });
      expect(update.input.ExpressionAttributeValues).toEqual(
        expect.objectContaining({
          ':name': 'Winter Wardrobe',
          ':updatedAt': expect.stringMatching(ISO8601),
        }),
      );
    });

    it('returns 404 WARDROBE_NOT_FOUND when patching another user wardrobe', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(
          event({
            method: 'PATCH',
            wardrobeId: WARDROBE_ID,
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

  describe('DELETE /wardrobes/{wardrobeId}', () => {
    it('cascades items, outfits, renders, and S3 objects and returns 204', async () => {
      const wardrobe = dynamoWardrobe(OWNER_ID, {
        coverImageKey: WARDROBE_OWN_KEY,
      });
      const item = cascadeItem();
      const outfit = dynamoOutfit(OWNER_ID);
      const wornOn = dynamoWornOn(OWNER_ID);
      const shopping = dynamoShopping(OWNER_ID);
      const share = dynamoShare(OWNER_ID);

      mockDeleteCascade({
        wardrobe,
        children: [item, outfit, wornOn, shopping],
        shares: [share],
        s3ByPrefix: {
          [`users/${OWNER_ID}/wardrobes/${WARDROBE_ID}/`]: [WARDROBE_OWN_KEY],
          [`users/${OWNER_ID}/items/${ITEM_ID}/`]: [
            ITEM_PROCESSED_KEY,
            ITEM_RENDER_KEY,
          ],
          [`users/${OWNER_ID}/outfits/${OUTFIT_ID}/`]: [OUTFIT_RENDER_KEY],
        },
      });

      const result = asResult(
        await handler(event({ method: 'DELETE', wardrobeId: WARDROBE_ID })),
      );

      expect(result.statusCode).toBe(204);
      expect(result.body).toBe('');
      expect(result.body).not.toContain('{');

      expect(deletedKeys()).toEqual(
        expect.arrayContaining([
          { PK: `USER#${OWNER_ID}`, SK: `WARDROBE#${WARDROBE_ID}` },
          { PK: `WARDROBE#${WARDROBE_ID}`, SK: `ITEM#${ITEM_ID}` },
          { PK: `WARDROBE#${WARDROBE_ID}`, SK: `OUTFIT#${OUTFIT_ID}` },
          {
            PK: `WARDROBE#${WARDROBE_ID}`,
            SK: `OUTFIT#${OUTFIT_ID}#WORN#${WORN_ON}`,
          },
          { PK: `WARDROBE#${WARDROBE_ID}`, SK: `SHOPPING#${ITEM_ID}` },
          { PK: `SHARE#${SHARE_TOKEN}`, SK: 'SHARE' },
        ]),
      );
      expect(deletedKeys()).not.toContainEqual({
        PK: `USER#${OWNER_ID}`,
        SK: `WARDROBE#${OTHER_WARDROBE_ID}`,
      });

      expect(listedS3Prefixes()).toEqual(
        expect.arrayContaining([
          `users/${OWNER_ID}/wardrobes/${WARDROBE_ID}/`,
          `users/${OWNER_ID}/items/${ITEM_ID}/`,
          `users/${OWNER_ID}/outfits/${OUTFIT_ID}/`,
        ]),
      );
      expect(listedS3Prefixes()).not.toContain(`users/${OWNER_ID}/`);
      expect(listedS3Prefixes().some((prefix) => prefix.includes(OTHER_ID))).toBe(
        false,
      );

      expect(deletedS3Keys()).toEqual(
        expect.arrayContaining([
          WARDROBE_OWN_KEY,
          ITEM_PROCESSED_KEY,
          ITEM_RENDER_KEY,
          OUTFIT_RENDER_KEY,
          ITEM_ORIGINAL_KEY,
        ]),
      );
      expect(deletedS3Keys()).not.toContain(OTHER_ITEM_ORIGINAL_KEY);
      expect(deletedS3Keys()).not.toContain(OTHER_USER_KEY);
    });

    it('leaves other wardrobes and other users untouched', async () => {
      const otherWardrobe = dynamoWardrobe(OWNER_ID, {
        wardrobeId: OTHER_WARDROBE_ID,
        SK: `WARDROBE#${OTHER_WARDROBE_ID}`,
        name: 'Keep Me',
      });
      const otherItem = dynamoItem(OWNER_ID, {
        itemId: OTHER_ITEM_ID,
        wardrobeId: OTHER_WARDROBE_ID,
        PK: `WARDROBE#${OTHER_WARDROBE_ID}`,
        originalKey: OTHER_ITEM_ORIGINAL_KEY,
      });
      const otherOutfit = dynamoOutfit(OWNER_ID, {
        wardrobeId: OTHER_WARDROBE_ID,
        outfitId: OTHER_OUTFIT_ID,
        items: [{ itemId: OTHER_ITEM_ID, slot: 'TOP' }],
        render: undefined,
        renderHistory: undefined,
      });
      const otherShare = dynamoShare(OWNER_ID, {
        token: OTHER_SHARE_TOKEN,
        wardrobeId: OTHER_WARDROBE_ID,
        itemId: OTHER_ITEM_ID,
      });

      mockDeleteCascade({
        wardrobe: dynamoWardrobe(OWNER_ID),
        children: [cascadeItem(), dynamoOutfit(OWNER_ID)],
        otherWardrobes: [otherWardrobe],
        otherChildren: { [OTHER_WARDROBE_ID]: [otherItem, otherOutfit] },
        shares: [otherShare],
        s3ByPrefix: {
          [`users/${OWNER_ID}/wardrobes/${WARDROBE_ID}/`]: [],
          [`users/${OWNER_ID}/items/${ITEM_ID}/`]: [ITEM_PROCESSED_KEY],
          [`users/${OWNER_ID}/outfits/${OUTFIT_ID}/`]: [OUTFIT_RENDER_KEY],
        },
      });

      const result = asResult(
        await handler(event({ method: 'DELETE', wardrobeId: WARDROBE_ID })),
      );

      expect(result.statusCode).toBe(204);
      expect(deletedKeys()).toEqual(
        expect.arrayContaining([
          { PK: `USER#${OWNER_ID}`, SK: `WARDROBE#${WARDROBE_ID}` },
          { PK: `WARDROBE#${WARDROBE_ID}`, SK: `ITEM#${ITEM_ID}` },
          { PK: `WARDROBE#${WARDROBE_ID}`, SK: `OUTFIT#${OUTFIT_ID}` },
        ]),
      );
      expect(deletedKeys()).not.toContainEqual({
        PK: `USER#${OWNER_ID}`,
        SK: `WARDROBE#${OTHER_WARDROBE_ID}`,
      });
      expect(deletedKeys()).not.toContainEqual({
        PK: `WARDROBE#${OTHER_WARDROBE_ID}`,
        SK: `ITEM#${OTHER_ITEM_ID}`,
      });
      expect(deletedKeys()).not.toContainEqual({
        PK: `WARDROBE#${OTHER_WARDROBE_ID}`,
        SK: `OUTFIT#${OTHER_OUTFIT_ID}`,
      });
      expect(deletedKeys()).not.toContainEqual({
        PK: `SHARE#${OTHER_SHARE_TOKEN}`,
        SK: 'SHARE',
      });
      expect(
        deletedKeys().some(
          (key) => key.PK.includes(OTHER_ID) || key.SK.includes(OTHER_ID),
        ),
      ).toBe(false);

      const queriedPks = mockSend.mock.calls
        .map((call) => call[0] as Command)
        .filter((command) => command._op === 'Query')
        .map(
          (command) =>
            command.input.ExpressionAttributeValues?.[':pk'] ??
            command.input.Key?.PK,
        );
      expect(queriedPks).not.toContain(`USER#${OTHER_ID}`);
      expect(listedS3Prefixes()).not.toContain(
        `users/${OWNER_ID}/items/${OTHER_ITEM_ID}/`,
      );
      expect(listedS3Prefixes()).not.toContain(
        `users/${OWNER_ID}/outfits/${OTHER_OUTFIT_ID}/`,
      );
      expect(deletedS3Keys()).not.toContain(OTHER_ITEM_ORIGINAL_KEY);
      expect(deletedS3Keys()).not.toContain(OTHER_USER_KEY);
    });

    it('strips deleted item ids from another wardrobe outfit and keeps it', async () => {
      const otherWardrobe = dynamoWardrobe(OWNER_ID, {
        wardrobeId: OTHER_WARDROBE_ID,
        SK: `WARDROBE#${OTHER_WARDROBE_ID}`,
        name: 'Keep Me',
      });
      const keptOutfit = dynamoOutfit(OWNER_ID, {
        wardrobeId: OTHER_WARDROBE_ID,
        outfitId: CROSS_OUTFIT_ID,
        items: [
          { itemId: ITEM_ID, slot: 'TOP' },
          { itemId: OTHER_ITEM_ID, slot: 'BOTTOM' },
        ],
        render: {
          status: 'READY',
          imageKey: CROSS_RENDER_KEY,
          aiProfileId: 'ap_1',
        },
        renderHistory: [
          {
            imageKey: CROSS_RENDER_KEY,
            createdAt: '2026-09-18T19:00:00.000Z',
            aiProfileId: 'ap_1',
          },
        ],
      });

      mockDeleteCascade({
        children: [cascadeItem()],
        otherWardrobes: [otherWardrobe],
        otherChildren: { [OTHER_WARDROBE_ID]: [keptOutfit] },
        s3ByPrefix: {
          [`users/${OWNER_ID}/wardrobes/${WARDROBE_ID}/`]: [],
          [`users/${OWNER_ID}/items/${ITEM_ID}/`]: [ITEM_PROCESSED_KEY],
          [`users/${OWNER_ID}/outfits/${CROSS_OUTFIT_ID}/`]: [CROSS_RENDER_KEY],
        },
      });

      const result = asResult(
        await handler(event({ method: 'DELETE', wardrobeId: WARDROBE_ID })),
      );

      expect(result.statusCode).toBe(204);
      expect(result.body).toBe('');
      expect(deletedKeys()).not.toContainEqual({
        PK: `WARDROBE#${OTHER_WARDROBE_ID}`,
        SK: `OUTFIT#${CROSS_OUTFIT_ID}`,
      });
      expect(deletedKeys()).toEqual(
        expect.arrayContaining([
          { PK: `USER#${OWNER_ID}`, SK: `WARDROBE#${WARDROBE_ID}` },
          { PK: `WARDROBE#${WARDROBE_ID}`, SK: `ITEM#${ITEM_ID}` },
        ]),
      );

      const updates = outfitUpdates();
      expect(updates).toHaveLength(1);
      expect(updates[0]?.input.Key).toEqual({
        PK: `WARDROBE#${OTHER_WARDROBE_ID}`,
        SK: `OUTFIT#${CROSS_OUTFIT_ID}`,
      });
      expect(updates[0]?.input.ExpressionAttributeValues?.[':items']).toEqual([
        { itemId: OTHER_ITEM_ID, slot: 'BOTTOM' },
      ]);
      expect(updates[0]?.input.UpdateExpression).toContain('REMOVE');
      expect(updates[0]?.input.ExpressionAttributeNames).toEqual(
        expect.objectContaining({
          '#render': 'render',
          '#renderHistory': 'renderHistory',
          '#renderImageUrls': 'renderImageUrls',
        }),
      );
    });

    it('clears try-on renders on a kept outfit that referenced deleted items', async () => {
      const otherWardrobe = dynamoWardrobe(OWNER_ID, {
        wardrobeId: OTHER_WARDROBE_ID,
        SK: `WARDROBE#${OTHER_WARDROBE_ID}`,
        name: 'Keep Me',
      });
      const keptOutfit = dynamoOutfit(OWNER_ID, {
        wardrobeId: OTHER_WARDROBE_ID,
        outfitId: CROSS_OUTFIT_ID,
        items: [
          { itemId: ITEM_ID, slot: 'TOP' },
          { itemId: OTHER_ITEM_ID, slot: 'BOTTOM' },
        ],
        render: {
          status: 'READY',
          imageKey: CROSS_RENDER_KEY,
          aiProfileId: 'ap_1',
        },
        renderHistory: [
          {
            imageKey: CROSS_RENDER_KEY,
            createdAt: '2026-09-18T19:00:00.000Z',
            aiProfileId: 'ap_1',
          },
        ],
        renderImageUrls: ['https://signed.example/stale'],
      });

      mockDeleteCascade({
        children: [cascadeItem()],
        otherWardrobes: [otherWardrobe],
        otherChildren: { [OTHER_WARDROBE_ID]: [keptOutfit] },
        s3ByPrefix: {
          [`users/${OWNER_ID}/wardrobes/${WARDROBE_ID}/`]: [],
          [`users/${OWNER_ID}/items/${ITEM_ID}/`]: [ITEM_PROCESSED_KEY],
          [`users/${OWNER_ID}/outfits/${CROSS_OUTFIT_ID}/`]: [CROSS_RENDER_KEY],
        },
      });

      const result = asResult(
        await handler(event({ method: 'DELETE', wardrobeId: WARDROBE_ID })),
      );

      expect(result.statusCode).toBe(204);
      expect(listedS3Prefixes()).toContain(
        `users/${OWNER_ID}/outfits/${CROSS_OUTFIT_ID}/`,
      );
      expect(deletedS3Keys()).toContain(CROSS_RENDER_KEY);
      expect(outfitUpdates()[0]?.input.UpdateExpression).toEqual(
        expect.stringMatching(/REMOVE.*#render/),
      );
      expect(outfitUpdates()[0]?.input.ExpressionAttributeValues).not.toEqual(
        expect.objectContaining({
          ':render': expect.anything(),
          ':renderHistory': expect.anything(),
          ':renderImageUrls': expect.anything(),
        }),
      );
    });

    it('deletes another wardrobe outfit when stripping leaves zero items', async () => {
      const otherWardrobe = dynamoWardrobe(OWNER_ID, {
        wardrobeId: OTHER_WARDROBE_ID,
        SK: `WARDROBE#${OTHER_WARDROBE_ID}`,
        name: 'Keep Me',
      });
      const emptiedOutfit = dynamoOutfit(OWNER_ID, {
        wardrobeId: OTHER_WARDROBE_ID,
        outfitId: CROSS_OUTFIT_ID,
        items: [{ itemId: ITEM_ID, slot: 'TOP' }],
        render: {
          status: 'READY',
          imageKey: CROSS_RENDER_KEY,
          aiProfileId: 'ap_1',
        },
      });
      const emptiedWornOn = dynamoWornOn(OWNER_ID, {
        wardrobeId: OTHER_WARDROBE_ID,
        outfitId: CROSS_OUTFIT_ID,
      });

      mockDeleteCascade({
        children: [cascadeItem()],
        otherWardrobes: [otherWardrobe],
        otherChildren: {
          [OTHER_WARDROBE_ID]: [emptiedOutfit, emptiedWornOn],
        },
        s3ByPrefix: {
          [`users/${OWNER_ID}/wardrobes/${WARDROBE_ID}/`]: [],
          [`users/${OWNER_ID}/items/${ITEM_ID}/`]: [ITEM_PROCESSED_KEY],
          [`users/${OWNER_ID}/outfits/${CROSS_OUTFIT_ID}/`]: [CROSS_RENDER_KEY],
        },
      });

      const result = asResult(
        await handler(event({ method: 'DELETE', wardrobeId: WARDROBE_ID })),
      );

      expect(result.statusCode).toBe(204);
      expect(outfitUpdates()).toEqual([]);
      expect(deletedKeys()).toEqual(
        expect.arrayContaining([
          {
            PK: `WARDROBE#${OTHER_WARDROBE_ID}`,
            SK: `OUTFIT#${CROSS_OUTFIT_ID}`,
          },
          {
            PK: `WARDROBE#${OTHER_WARDROBE_ID}`,
            SK: `OUTFIT#${CROSS_OUTFIT_ID}#WORN#${WORN_ON}`,
          },
        ]),
      );
      expect(deletedKeys()).not.toContainEqual({
        PK: `USER#${OWNER_ID}`,
        SK: `WARDROBE#${OTHER_WARDROBE_ID}`,
      });
      expect(deletedS3Keys()).toContain(CROSS_RENDER_KEY);
    });

    it('pages Dynamo children so a large wardrobe is fully deleted', async () => {
      const first = cascadeItem();
      const second = dynamoOutfit(OWNER_ID);
      mockDeleteCascade({
        children: [first, second],
        paginateChildren: true,
        s3ByPrefix: {
          [`users/${OWNER_ID}/wardrobes/${WARDROBE_ID}/`]: [],
          [`users/${OWNER_ID}/items/${ITEM_ID}/`]: [ITEM_PROCESSED_KEY],
          [`users/${OWNER_ID}/outfits/${OUTFIT_ID}/`]: [OUTFIT_RENDER_KEY],
        },
      });

      const result = asResult(
        await handler(event({ method: 'DELETE', wardrobeId: WARDROBE_ID })),
      );

      expect(result.statusCode).toBe(204);
      expect(deletedKeys()).toEqual(
        expect.arrayContaining([
          { PK: `USER#${OWNER_ID}`, SK: `WARDROBE#${WARDROBE_ID}` },
          { PK: `WARDROBE#${WARDROBE_ID}`, SK: `ITEM#${ITEM_ID}` },
          { PK: `WARDROBE#${WARDROBE_ID}`, SK: `OUTFIT#${OUTFIT_ID}` },
        ]),
      );
      const childQueries = mockSend.mock.calls
        .map((call) => call[0] as Command)
        .filter(
          (command) =>
            command._op === 'Query' &&
            command.input.ExpressionAttributeValues?.[':pk'] ===
              `WARDROBE#${WARDROBE_ID}`,
        );
      expect(childQueries).toHaveLength(2);
      expect(childQueries[1]?.input.ExclusiveStartKey).toEqual({
        PK: first.PK,
        SK: first.SK,
      });
    });

    it('chunks Dynamo deletes at the BatchWriteItem limit', async () => {
      const manyItems = Array.from({ length: 26 }, (_, index) =>
        dynamoItem(OWNER_ID, {
          itemId: `item_batch${String(index).padStart(7, '0')}`,
          originalKey: `users/${OWNER_ID}/uploads/batch-${index}.jpg`,
        }),
      );
      mockDeleteCascade({
        children: manyItems,
        s3ByPrefix: {},
      });

      const result = asResult(
        await handler(event({ method: 'DELETE', wardrobeId: WARDROBE_ID })),
      );

      expect(result.statusCode).toBe(204);
      const batches = mockSend.mock.calls
        .map((call) => call[0] as Command)
        .filter((command) => command._op === 'BatchWrite');
      expect(batches.length).toBeGreaterThanOrEqual(2);
      expect(
        batches.every((batch) => {
          const requests = Object.values(batch.input.RequestItems ?? {})[0] ?? [];
          return requests.length <= 25;
        }),
      ).toBe(true);
      expect(deletedKeys()).toHaveLength(27);
    });

    it('returns 204 with an empty body when the wardrobe has no children', async () => {
      mockDeleteCascade({ children: [] });

      const result = asResult(
        await handler(event({ method: 'DELETE', wardrobeId: WARDROBE_ID })),
      );

      expect(result.statusCode).toBe(204);
      expect(result.body).toBe('');
      expect(deletedKeys()).toEqual([
        { PK: `USER#${OWNER_ID}`, SK: `WARDROBE#${WARDROBE_ID}` },
      ]);
    });

    it('returns 401 UNAUTHENTICATED when deleting without an authorizer', async () => {
      const result = asResult(
        await handler(
          event({ method: 'DELETE', wardrobeId: WARDROBE_ID, sub: null }),
        ),
      );

      expectEnvelope(result, 401, 'UNAUTHENTICATED');
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('returns 404 WARDROBE_NOT_FOUND when deleting a missing wardrobe', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(event({ method: 'DELETE', wardrobeId: WARDROBE_ID })),
      );

      expectEnvelope(result, 404, 'WARDROBE_NOT_FOUND');
      expect(
        mockSend.mock.calls.some(
          (call) =>
            (call[0] as Command)._op === 'Delete' ||
            (call[0] as Command)._op === 'BatchWrite',
        ),
      ).toBe(false);
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('returns 404 WARDROBE_NOT_FOUND when deleting another user wardrobe', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(
          event({
            method: 'DELETE',
            wardrobeId: WARDROBE_ID,
            sub: OTHER_ID,
          }),
        ),
      );

      expectEnvelope(result, 404, 'WARDROBE_NOT_FOUND');
      const get = mockSend.mock.calls[0][0] as Command;
      expect(get.input.Key?.PK).toBe(`USER#${OTHER_ID}`);
      expect(
        mockSend.mock.calls.some(
          (call) => (call[0] as Command)._op === 'BatchWrite',
        ),
      ).toBe(false);
      expect(mockS3Send).not.toHaveBeenCalled();
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
            body: { name: 'Spoofed', userId: OTHER_ID },
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
      ['missing name', { userId: OTHER_ID }, 'name must be a string.'],
      ['non-string name', { name: 12 }, 'name must be a string.'],
      ['blank name', { name: '   ' }, 'name is required.'],
      [
        'name longer than 100 characters',
        { name: 'a'.repeat(101) },
        'name must be 100 characters or fewer.',
      ],
    ])('returns 400 VALIDATION_ERROR for %s on create', async (_label, body, message) => {
      const result = asResult(await handler(event({ method: 'POST', body })));

      expect(result.statusCode).toBe(400);
      expect(bodyOf(result)).toEqual({
        error: { code: 'VALIDATION_ERROR', message },
      });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns 400 VALIDATION_ERROR when the create body is missing', async () => {
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

    it('returns 400 VALIDATION_ERROR when patch name is blank', async () => {
      mockSend.mockResolvedValue({ Item: dynamoWardrobe(OWNER_ID) });

      const result = asResult(
        await handler(
          event({
            method: 'PATCH',
            wardrobeId: WARDROBE_ID,
            body: { name: ' ' },
          }),
        ),
      );

      expect(result.statusCode).toBe(400);
      expect(bodyOf(result)).toEqual({
        error: { code: 'VALIDATION_ERROR', message: 'name is required.' },
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
