import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DynamoItem, OutfitWornOn } from '../../src/shared/types';

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

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({ send: jest.fn() })),
  SendMessageCommand: jest.fn(),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({})),
  GetObjectCommand: jest.fn(),
  PutObjectCommand: jest.fn(),
  ListObjectsV2Command: jest.fn(),
  DeleteObjectsCommand: jest.fn(),
}));

import { handler } from '../../src/functions/outfits/handler';

const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OWNER_ID = 'firebase-uid-owner';
const OTHER_ID = 'firebase-uid-other';
const WARDROBE_ID = 'wd_abc123xyz0';
const OUTFIT_ID = 'outfit_xyz123ab';
const OTHER_OUTFIT_ID = 'outfit_other99zz';
const WORN_ON = '2026-09-18';
const EARLIER = '2026-09-10';

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

function dynamoOutfit(
  userId = OWNER_ID,
  overrides: Partial<DynamoItem> = {},
): DynamoItem {
  return {
    PK: `WARDROBE#${WARDROBE_ID}`,
    SK: `OUTFIT#${OUTFIT_ID}`,
    entityType: 'OUTFIT',
    userId,
    wardrobeId: WARDROBE_ID,
    outfitId: OUTFIT_ID,
    name: 'Friday Night',
    items: [{ itemId: 'item_top123abcd', slot: 'TOP' }],
    createdAt: '2026-09-03T19:10:00.000Z',
    updatedAt: '2026-09-03T19:10:00.000Z',
    ...overrides,
  };
}

function dynamoWornOn(
  wornOn = WORN_ON,
  overrides: Partial<DynamoItem> = {},
): DynamoItem {
  const outfitId = String(overrides.outfitId ?? OUTFIT_ID);
  return {
    PK: `WARDROBE#${WARDROBE_ID}`,
    SK: `OUTFIT#${outfitId}#WORN#${wornOn}`,
    entityType: 'WORN_ON',
    userId: OWNER_ID,
    wardrobeId: WARDROBE_ID,
    outfitId,
    wornOn,
    createdAt: `${wornOn}T19:10:00.000Z`,
    updatedAt: `${wornOn}T19:10:00.000Z`,
    ...overrides,
  };
}

function wornOnDto(overrides: Partial<OutfitWornOn> = {}): OutfitWornOn {
  return {
    outfitId: OUTFIT_ID,
    wardrobeId: WARDROBE_ID,
    wornOn: WORN_ON,
    createdAt: '2026-09-18T19:10:00.000Z',
    ...overrides,
  };
}

function event(options: {
  method: string;
  wardrobeId?: string;
  outfitId?: string | null;
  date?: string;
  wardrobeCalendar?: boolean;
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

  let rawPath = `/wardrobes/${wardrobeId}/worn-on`;
  let routeKey = `${options.method} /wardrobes/{wardrobeId}/worn-on`;
  const pathParameters: Record<string, string> = { wardrobeId };

  if (!options.wardrobeCalendar && options.outfitId !== null) {
    const outfitId = options.outfitId ?? OUTFIT_ID;
    pathParameters.outfitId = outfitId;
    if (options.date) {
      pathParameters.date = options.date;
      rawPath = `/wardrobes/${wardrobeId}/outfits/${outfitId}/worn-on/${options.date}`;
      routeKey = `${options.method} /wardrobes/{wardrobeId}/outfits/{outfitId}/worn-on/{date}`;
    } else {
      rawPath = `/wardrobes/${wardrobeId}/outfits/${outfitId}/worn-on`;
      routeKey = `${options.method} /wardrobes/{wardrobeId}/outfits/{outfitId}/worn-on`;
    }
  }

  const queryStringParameters = options.query;
  const rawQueryString = queryStringParameters
    ? Object.entries(queryStringParameters)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${value}`)
        .join('&')
    : '';

  return {
    version: '2.0',
    routeKey,
    rawPath,
    rawQueryString,
    headers: { authorization: 'Bearer unused-in-handler' },
    body:
      options.rawBody !== undefined
        ? options.rawBody
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined,
    pathParameters,
    queryStringParameters,
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

function mockOwnedOutfitThen(next: (command: Command) => Promise<unknown>) {
  mockSend.mockImplementation(async (command: Command) => {
    if (command._op === 'Get' && command.input.Key?.SK === `WARDROBE#${WARDROBE_ID}`) {
      return { Item: dynamoWardrobe() };
    }
    if (command._op === 'Get' && command.input.Key?.SK === `OUTFIT#${OUTFIT_ID}`) {
      return { Item: dynamoOutfit() };
    }
    return next(command);
  });
}

describe('outfit worn-on log (WARDROBE-120)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
  });

  afterEach(() => {
    delete process.env.TABLE_NAME;
  });

  describe('POST /wardrobes/{wardrobeId}/outfits/{outfitId}/worn-on', () => {
    it('creates a date-only entry under the outfit key and returns 201', async () => {
      mockOwnedOutfitThen(async (command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.includes('#WORN#')) {
          return {};
        }
        if (command._op === 'Put') {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({ method: 'POST', body: { wornOn: `  ${WORN_ON}  ` } }),
        ),
      );

      expect(result.statusCode).toBe(201);
      const body = bodyOf(result) as OutfitWornOn;
      expect(body).toEqual({
        outfitId: OUTFIT_ID,
        wardrobeId: WARDROBE_ID,
        wornOn: WORN_ON,
        createdAt: expect.stringMatching(ISO8601),
      });
      expect(body).not.toHaveProperty('userId');
      expect(body).not.toHaveProperty('PK');
      expect(JSON.stringify(body)).not.toContain('null');

      const put = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Put',
      )?.[0] as Command;
      expect(put.input.Item).toEqual(
        expect.objectContaining({
          PK: `WARDROBE#${WARDROBE_ID}`,
          SK: `OUTFIT#${OUTFIT_ID}#WORN#${WORN_ON}`,
          entityType: 'WORN_ON',
          userId: OWNER_ID,
          wardrobeId: WARDROBE_ID,
          outfitId: OUTFIT_ID,
          wornOn: WORN_ON,
        }),
      );
    });

    it('returns 200 with the existing entry when the date is already logged', async () => {
      const existing = dynamoWornOn();
      mockOwnedOutfitThen(async (command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.includes('#WORN#')) {
          return { Item: existing };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'POST', body: { wornOn: WORN_ON } })),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual(wornOnDto());
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Put'),
      ).toBe(false);
    });

    it('ignores body userId and uses the Firebase authorizer', async () => {
      mockOwnedOutfitThen(async (command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.includes('#WORN#')) {
          return {};
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
            body: { wornOn: WORN_ON, userId: OTHER_ID },
          }),
        ),
      );

      expect(result.statusCode).toBe(201);
      const put = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Put',
      )?.[0] as Command;
      expect(put.input.Item?.userId).toBe(OWNER_ID);
    });

    it.each([
      ['datetime', '2026-09-18T12:00:00.000Z', 'wornOn must be an ISO date (YYYY-MM-DD).'],
      ['invalid calendar', '2026-02-31', 'wornOn must be a valid calendar date (YYYY-MM-DD).'],
      ['missing', undefined, 'wornOn must be a string.'],
    ])('returns 400 VALIDATION_ERROR for %s wornOn', async (_label, wornOn, message) => {
      mockOwnedOutfitThen(async () => {
        throw new Error('should not reach Dynamo after validation');
      });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            body: wornOn === undefined ? {} : { wornOn },
          }),
        ),
      );

      expectEnvelope(result, 400, 'VALIDATION_ERROR');
      expect((bodyOf(result) as { error: { message: string } }).error.message).toBe(
        message,
      );
    });

    it('returns 404 OUTFIT_NOT_FOUND for another user outfit', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK === `WARDROBE#${WARDROBE_ID}`) {
          return { Item: dynamoWardrobe() };
        }
        if (command._op === 'Get' && command.input.Key?.SK === `OUTFIT#${OUTFIT_ID}`) {
          return { Item: dynamoOutfit(OTHER_ID) };
        }
        return {};
      });

      const result = asResult(
        await handler(event({ method: 'POST', body: { wornOn: WORN_ON } })),
      );

      expectEnvelope(result, 404, 'OUTFIT_NOT_FOUND');
    });
  });

  describe('GET /wardrobes/{wardrobeId}/outfits/{outfitId}/worn-on', () => {
    it('lists owned dates newest first', async () => {
      mockOwnedOutfitThen(async (command) => {
        if (command._op === 'Query') {
          expect(command.input.ExpressionAttributeValues).toEqual({
            ':pk': `WARDROBE#${WARDROBE_ID}`,
            ':sk': `OUTFIT#${OUTFIT_ID}#WORN#`,
          });
          return {
            Items: [
              dynamoWornOn(EARLIER),
              dynamoWornOn(),
              dynamoOutfit(),
              dynamoWornOn(WORN_ON, { userId: OTHER_ID }),
            ],
          };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(await handler(event({ method: 'GET' })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({
        entries: [
          wornOnDto(),
          wornOnDto({ wornOn: EARLIER, createdAt: '2026-09-10T19:10:00.000Z' }),
        ],
      });
    });

    it('returns an empty entries array when none are logged', async () => {
      mockOwnedOutfitThen(async (command) => {
        if (command._op === 'Query') {
          return { Items: [] };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(await handler(event({ method: 'GET' })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ entries: [] });
    });

    it('returns 404 WARDROBE_NOT_FOUND for a missing wardrobe', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(await handler(event({ method: 'GET' })));

      expectEnvelope(result, 404, 'WARDROBE_NOT_FOUND');
    });
  });

  describe('DELETE /wardrobes/{wardrobeId}/outfits/{outfitId}/worn-on/{date}', () => {
    it('removes an owned date and returns 204', async () => {
      mockOwnedOutfitThen(async (command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.includes('#WORN#')) {
          return { Item: dynamoWornOn() };
        }
        if (command._op === 'Delete') {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'DELETE', date: WORN_ON })),
      );

      expect(result.statusCode).toBe(204);
      expect(result.body).toBe('');
      const del = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Delete',
      )?.[0] as Command;
      expect(del.input.Key).toEqual({
        PK: `WARDROBE#${WARDROBE_ID}`,
        SK: `OUTFIT#${OUTFIT_ID}#WORN#${WORN_ON}`,
      });
    });

    it('returns 204 when the date was never logged', async () => {
      mockOwnedOutfitThen(async (command) => {
        if (command._op === 'Get' && command.input.Key?.SK?.includes('#WORN#')) {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'DELETE', date: WORN_ON })),
      );

      expect(result.statusCode).toBe(204);
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Delete'),
      ).toBe(false);
    });

    it('returns 400 VALIDATION_ERROR for a datetime path date', async () => {
      mockOwnedOutfitThen(async () => {
        throw new Error('should not reach Dynamo after validation');
      });

      const result = asResult(
        await handler(
          event({ method: 'DELETE', date: '2026-09-18T12:00:00.000Z' }),
        ),
      );

      expectEnvelope(result, 400, 'VALIDATION_ERROR');
    });
  });

  describe('GET /wardrobes/{wardrobeId}/worn-on', () => {
    it('lists wardrobe dates newest first for the calendar', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK === `WARDROBE#${WARDROBE_ID}`) {
          return { Item: dynamoWardrobe() };
        }
        if (command._op === 'Query') {
          return {
            Items: [
              dynamoOutfit(),
              dynamoWornOn(EARLIER),
              dynamoWornOn(),
              dynamoWornOn(WORN_ON, { outfitId: OTHER_OUTFIT_ID }),
              dynamoWornOn(WORN_ON, { userId: OTHER_ID }),
            ],
          };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'GET', wardrobeCalendar: true })),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({
        entries: [
          wornOnDto({ outfitId: OTHER_OUTFIT_ID }),
          wornOnDto(),
          wornOnDto({ wornOn: EARLIER, createdAt: '2026-09-10T19:10:00.000Z' }),
        ],
      });
    });

    it('applies inclusive from/to bounds', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK === `WARDROBE#${WARDROBE_ID}`) {
          return { Item: dynamoWardrobe() };
        }
        if (command._op === 'Query') {
          return {
            Items: [
              dynamoWornOn('2026-09-01'),
              dynamoWornOn(EARLIER),
              dynamoWornOn(),
            ],
          };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'GET',
            wardrobeCalendar: true,
            query: { from: EARLIER, to: EARLIER },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({
        entries: [
          wornOnDto({ wornOn: EARLIER, createdAt: '2026-09-10T19:10:00.000Z' }),
        ],
      });
    });

    it('returns 400 when from is after to', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK === `WARDROBE#${WARDROBE_ID}`) {
          return { Item: dynamoWardrobe() };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'GET',
            wardrobeCalendar: true,
            query: { from: WORN_ON, to: EARLIER },
          }),
        ),
      );

      expectEnvelope(result, 400, 'VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR for an invalid from date', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.SK === `WARDROBE#${WARDROBE_ID}`) {
          return { Item: dynamoWardrobe() };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'GET',
            wardrobeCalendar: true,
            query: { from: '2026-09-18T00:00:00.000Z' },
          }),
        ),
      );

      expectEnvelope(result, 400, 'VALIDATION_ERROR');
    });
  });

  describe('DELETE outfit cascades worn-on rows', () => {
    it('deletes worn-on children then the outfit', async () => {
      mockOwnedOutfitThen(async (command) => {
        if (command._op === 'Query') {
          return { Items: [dynamoWornOn(), dynamoWornOn(EARLIER)] };
        }
        if (command._op === 'Delete') {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler({
          ...event({ method: 'DELETE' }),
          rawPath: `/wardrobes/${WARDROBE_ID}/outfits/${OUTFIT_ID}`,
          routeKey: `DELETE /wardrobes/{wardrobeId}/outfits/{outfitId}`,
          pathParameters: { wardrobeId: WARDROBE_ID, outfitId: OUTFIT_ID },
          requestContext: {
            ...event({ method: 'DELETE' }).requestContext,
            http: {
              ...event({ method: 'DELETE' }).requestContext.http,
              path: `/wardrobes/${WARDROBE_ID}/outfits/${OUTFIT_ID}`,
            },
            routeKey: `DELETE /wardrobes/{wardrobeId}/outfits/{outfitId}`,
          },
        }),
      );

      expect(result.statusCode).toBe(204);
      const deleted = mockSend.mock.calls
        .map((call) => call[0] as Command)
        .filter((command) => command._op === 'Delete')
        .map((command) => command.input.Key);
      expect(deleted).toEqual([
        { PK: `WARDROBE#${WARDROBE_ID}`, SK: `OUTFIT#${OUTFIT_ID}#WORN#${WORN_ON}` },
        { PK: `WARDROBE#${WARDROBE_ID}`, SK: `OUTFIT#${OUTFIT_ID}#WORN#${EARLIER}` },
        { PK: `WARDROBE#${WARDROBE_ID}`, SK: `OUTFIT#${OUTFIT_ID}` },
      ]);
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
  });
});
