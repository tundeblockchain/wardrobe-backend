import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DynamoItem, Wardrobe } from '../../src/shared/types';

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

import { handler } from '../../src/functions/wardrobes/handler';

const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OWNER_ID = 'firebase-uid-owner';
const OTHER_ID = 'firebase-uid-other';
const WARDROBE_ID = 'wd_abc123xyz0';

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

describe('wardrobes handler (WARDROBE-5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
  });

  afterEach(() => {
    delete process.env.TABLE_NAME;
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

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0] as Command;
      expect(command._op).toBe('Put');
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
      const command = mockSend.mock.calls[0][0] as Command;
      expect(command.input.Item?.userId).toBe(OWNER_ID);
      expect(command.input.Item?.PK).toBe(`USER#${OWNER_ID}`);
      expect(command.input.Item?.userId).not.toBe(OTHER_ID);
    });
  });

  describe('GET /wardrobes', () => {
    it('lists only the owner wardrobes under a wardrobes key', async () => {
      const owned = dynamoWardrobe(OWNER_ID);
      mockSend.mockResolvedValue({
        Items: [
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
      mockSend.mockResolvedValue({ Items: [] });

      const result = asResult(await handler(event({ method: 'GET' })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ wardrobes: [] });
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
    it('deletes an owned wardrobe and returns 204', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
          return { Item: dynamoWardrobe(OWNER_ID) };
        }
        if (command._op === 'Delete') {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'DELETE', wardrobeId: WARDROBE_ID })),
      );

      expect(result.statusCode).toBe(204);
      expect(result.body).toBe('');

      const del = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Delete',
      )?.[0] as Command;
      expect(del.input.Key).toEqual({
        PK: `USER#${OWNER_ID}`,
        SK: `WARDROBE#${WARDROBE_ID}`,
      });
    });

    it('returns 404 WARDROBE_NOT_FOUND when deleting a missing wardrobe', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(event({ method: 'DELETE', wardrobeId: WARDROBE_ID })),
      );

      expectEnvelope(result, 404, 'WARDROBE_NOT_FOUND');
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
