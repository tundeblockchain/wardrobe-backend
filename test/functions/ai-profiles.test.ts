import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { AiProfile, DynamoItem } from '../../src/shared/types';

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

import { handler } from '../../src/functions/ai-profiles/handler';
import { buildGenericModelProfile } from '../../src/functions/ai-profiles/model';

const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OWNER_ID = 'firebase-uid-owner';
const OTHER_ID = 'firebase-uid-other';
const PROFILE_ID = 'profile_abc123xy';
const GENERIC_ID = 'profile_model0001';

interface Command {
  _op: 'Put' | 'Get' | 'Query' | 'Update' | 'Delete';
  input: {
    TableName?: string;
    IndexName?: string;
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

function personalDto(overrides: Partial<AiProfile> = {}): AiProfile {
  return {
    aiProfileId: PROFILE_ID,
    type: 'PERSONAL',
    referenceImages: [],
    status: 'READY',
    createdAt: '2026-09-06T08:00:00.000Z',
    updatedAt: '2026-09-06T08:00:00.000Z',
    ...overrides,
  };
}

function dynamoPersonal(
  userId: string,
  overrides: Partial<DynamoItem> = {},
): DynamoItem {
  const dto = personalDto();
  return {
    PK: `USER#${userId}`,
    SK: `AIPROFILE#${dto.aiProfileId}`,
    entityType: 'AIPROFILE',
    userId,
    aiProfileId: dto.aiProfileId,
    type: 'PERSONAL',
    referenceImages: dto.referenceImages,
    status: dto.status,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    ...overrides,
  };
}

function dynamoGeneric(): DynamoItem {
  return buildGenericModelProfile({
    aiProfileId: GENERIC_ID,
    referenceImages: ['models/generic/model-a.png'],
    status: 'READY',
    createdAt: '2026-09-06T07:00:00.000Z',
    updatedAt: '2026-09-06T07:00:00.000Z',
  });
}

function genericDto(overrides: Partial<AiProfile> = {}): AiProfile {
  return {
    aiProfileId: GENERIC_ID,
    type: 'GENERIC_MODEL',
    referenceImages: ['models/generic/model-a.png'],
    status: 'READY',
    createdAt: '2026-09-06T07:00:00.000Z',
    updatedAt: '2026-09-06T07:00:00.000Z',
    ...overrides,
  };
}

function event(options: {
  method: string;
  aiProfileId?: string;
  models?: boolean;
  query?: Record<string, string>;
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

  const path = options.models
    ? '/ai-profiles/models'
    : options.aiProfileId
      ? `/ai-profiles/${options.aiProfileId}`
      : '/ai-profiles';
  const route = options.models
    ? `${options.method} /ai-profiles/models`
    : options.aiProfileId
      ? `${options.method} /ai-profiles/{aiProfileId}`
      : `${options.method} /ai-profiles`;

  const query = options.query ?? {};
  const rawQueryString = new URLSearchParams(query).toString();

  return {
    version: '2.0',
    routeKey: route,
    rawPath: path,
    rawQueryString,
    headers: { authorization: 'Bearer unused-in-handler' },
    queryStringParameters: Object.keys(query).length > 0 ? query : undefined,
    body:
      options.rawBody !== undefined
        ? options.rawBody
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined,
    pathParameters: options.aiProfileId
      ? { aiProfileId: options.aiProfileId }
      : undefined,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'example.com',
      domainPrefix: 'example',
      http: {
        method: options.method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'jest',
      },
      requestId: 'req-1',
      routeKey: route,
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

function expectFlutterDto(body: AiProfile): void {
  expect(body).not.toHaveProperty('userId');
  expect(body).not.toHaveProperty('PK');
  expect(body).not.toHaveProperty('SK');
  expect(body).not.toHaveProperty('GSI1PK');
  expect(body).not.toHaveProperty('GSI1SK');
  expect(body).not.toHaveProperty('entityType');
}

describe('ai-profiles handler (WARDROBE-43)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
  });

  afterEach(() => {
    delete process.env.TABLE_NAME;
  });

  describe('POST /ai-profiles', () => {
    it('creates a PERSONAL profile for the token UID with READY and empty refs', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(await handler(event({ method: 'POST', body: {} })));

      expect(result.statusCode).toBe(201);
      const body = bodyOf(result) as AiProfile;
      expect(body).toEqual({
        aiProfileId: expect.stringMatching(/^profile_[A-Za-z0-9_-]{12}$/),
        type: 'PERSONAL',
        referenceImages: [],
        status: 'READY',
        createdAt: expect.stringMatching(ISO8601),
        updatedAt: expect.stringMatching(ISO8601),
      });
      expectFlutterDto(body);
      expect(body.createdAt).toBe(body.updatedAt);

      const command = mockSend.mock.calls[0][0] as Command;
      expect(command._op).toBe('Put');
      expect(command.input.TableName).toBe('wardrobe-app-test');
      expect(command.input.Item).toEqual(
        expect.objectContaining({
          PK: `USER#${OWNER_ID}`,
          SK: `AIPROFILE#${body.aiProfileId}`,
          entityType: 'AIPROFILE',
          userId: OWNER_ID,
          type: 'PERSONAL',
          referenceImages: [],
          status: 'READY',
        }),
      );
      expect(command.input.Item).not.toHaveProperty('GSI1PK');
    });

    it('allows a missing body', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(await handler(event({ method: 'POST' })));

      expect(result.statusCode).toBe(201);
      expect((bodyOf(result) as AiProfile).type).toBe('PERSONAL');
    });

    it('ignores body userId and still owns the profile as the token UID', async () => {
      mockSend.mockResolvedValue({});

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            body: { type: 'PERSONAL', userId: OTHER_ID },
          }),
        ),
      );

      expect(result.statusCode).toBe(201);
      const command = mockSend.mock.calls[0][0] as Command;
      expect(command.input.Item?.userId).toBe(OWNER_ID);
      expect(command.input.Item?.PK).toBe(`USER#${OWNER_ID}`);
    });

    it('rejects GENERIC_MODEL on create', async () => {
      const result = asResult(
        await handler(event({ method: 'POST', body: { type: 'GENERIC_MODEL' } })),
      );

      expect(result.statusCode).toBe(400);
      expect(bodyOf(result)).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message:
            'type must be PERSONAL. GENERIC_MODEL profiles are seeded (WARDROBE-45).',
        },
      });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('accepts owned referenceImages as a WARDROBE-44 hook', async () => {
      mockSend.mockResolvedValue({});
      const key = `users/${OWNER_ID}/ai-profiles/tmp/reference-1.jpg`;

      const result = asResult(
        await handler(event({ method: 'POST', body: { referenceImages: [key] } })),
      );

      expect(result.statusCode).toBe(201);
      expect((bodyOf(result) as AiProfile).referenceImages).toEqual([key]);
      const command = mockSend.mock.calls[0][0] as Command;
      expect(command.input.Item?.referenceImages).toEqual([key]);
      expect(command.input.Item?.status).toBe('READY');
    });

    it('rejects another user referenceImages key', async () => {
      const result = asResult(
        await handler(
          event({
            method: 'POST',
            body: {
              referenceImages: [`users/${OTHER_ID}/ai-profiles/x.jpg`],
            },
          }),
        ),
      );

      expect(result.statusCode).toBe(400);
      expect(bodyOf(result)).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'referenceImages[0] must belong to the authenticated user.',
        },
      });
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('GET /ai-profiles', () => {
    it('lists only the caller PERSONAL profiles', async () => {
      const owned = dynamoPersonal(OWNER_ID);
      mockSend.mockResolvedValue({
        Items: [
          owned,
          {
            ...owned,
            SK: 'AIPROFILE#not-a-profile',
            entityType: 'PROFILE',
            aiProfileId: 'not-a-profile',
          },
        ],
      });

      const result = asResult(await handler(event({ method: 'GET' })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ aiProfiles: [personalDto()] });
      expectFlutterDto((bodyOf(result) as { aiProfiles: AiProfile[] }).aiProfiles[0]);

      const command = mockSend.mock.calls[0][0] as Command;
      expect(command._op).toBe('Query');
      expect(command.input.IndexName).toBeUndefined();
      expect(command.input.ExpressionAttributeValues).toEqual({
        ':pk': `USER#${OWNER_ID}`,
        ':sk': 'AIPROFILE#',
      });
    });

    it('returns an empty list when the owner has none', async () => {
      mockSend.mockResolvedValue({ Items: [] });

      const result = asResult(await handler(event({ method: 'GET' })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ aiProfiles: [] });
    });

    it('lists GENERIC_MODEL via GSI1 when type=GENERIC_MODEL', async () => {
      mockSend.mockResolvedValue({ Items: [dynamoGeneric()] });

      const result = asResult(
        await handler(event({ method: 'GET', query: { type: 'GENERIC_MODEL' } })),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ aiProfiles: [genericDto()] });

      const command = mockSend.mock.calls[0][0] as Command;
      expect(command._op).toBe('Query');
      expect(command.input.IndexName).toBe('GSI1');
      expect(command.input.ExpressionAttributeValues).toEqual({
        ':pk': 'TYPE#GENERIC_MODEL',
        ':sk': 'AIPROFILE#',
      });
    });

    it('falls back to the catalog PK when GSI1 is empty', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Query' && command.input.IndexName === 'GSI1') {
          return { Items: [] };
        }
        if (command._op === 'Query') {
          return { Items: [dynamoGeneric()] };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'GET', query: { type: 'GENERIC_MODEL' } })),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ aiProfiles: [genericDto()] });
      const catalog = mockSend.mock.calls
        .map((call) => call[0] as Command)
        .find((command) => command._op === 'Query' && !command.input.IndexName);
      expect(catalog?.input.ExpressionAttributeValues).toEqual({
        ':pk': 'AIPROFILE#GENERIC_MODEL',
        ':sk': 'AIPROFILE#',
      });
    });

    it('returns 400 for an unknown type query', async () => {
      const result = asResult(
        await handler(event({ method: 'GET', query: { type: 'AVATAR' } })),
      );

      expect(result.statusCode).toBe(400);
      expect(bodyOf(result)).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'type must be one of: PERSONAL, GENERIC_MODEL.',
        },
      });
    });
  });

  describe('GET /ai-profiles/models', () => {
    it('lists GENERIC_MODEL profiles for the try-on picker', async () => {
      mockSend.mockResolvedValue({ Items: [dynamoGeneric()] });

      const result = asResult(await handler(event({ method: 'GET', models: true })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ aiProfiles: [genericDto()] });
      const command = mockSend.mock.calls[0][0] as Command;
      expect(command.input.IndexName).toBe('GSI1');
    });

    it('returns seeded catalog labels and shared placeholder keys', async () => {
      const seeded = buildGenericModelProfile({
        aiProfileId: 'profile_generic_01',
        label: 'Alex',
        referenceImages: ['shared/ai-profiles/generic/alex/front.jpg'],
        status: 'READY',
        createdAt: '2026-09-06T00:00:00.000Z',
        updatedAt: '2026-09-06T00:00:00.000Z',
      });
      mockSend.mockResolvedValue({ Items: [seeded] });

      const result = asResult(await handler(event({ method: 'GET', models: true })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({
        aiProfiles: [
          {
            aiProfileId: 'profile_generic_01',
            type: 'GENERIC_MODEL',
            label: 'Alex',
            referenceImages: ['shared/ai-profiles/generic/alex/front.jpg'],
            status: 'READY',
            createdAt: '2026-09-06T00:00:00.000Z',
            updatedAt: '2026-09-06T00:00:00.000Z',
          },
        ],
      });
    });
  });

  describe('GET /ai-profiles/{aiProfileId}', () => {
    it('returns the owned PERSONAL DTO', async () => {
      mockSend.mockResolvedValue({ Item: dynamoPersonal(OWNER_ID) });

      const result = asResult(
        await handler(event({ method: 'GET', aiProfileId: PROFILE_ID })),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual(personalDto());
      expectFlutterDto(bodyOf(result) as AiProfile);

      const command = mockSend.mock.calls[0][0] as Command;
      expect(command._op).toBe('Get');
      expect(command.input.Key).toEqual({
        PK: `USER#${OWNER_ID}`,
        SK: `AIPROFILE#${PROFILE_ID}`,
      });
    });

    it('returns GENERIC_MODEL to any authenticated user', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.PK === `USER#${OWNER_ID}`) {
          return {};
        }
        if (
          command._op === 'Get' &&
          command.input.Key?.PK === 'AIPROFILE#GENERIC_MODEL'
        ) {
          return { Item: dynamoGeneric() };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'GET', aiProfileId: GENERIC_ID })),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual(genericDto());
    });

    it('returns 404 AI_PROFILE_NOT_FOUND when missing', async () => {
      mockSend.mockResolvedValue({ Items: [] });

      const result = asResult(
        await handler(event({ method: 'GET', aiProfileId: PROFILE_ID })),
      );

      expectEnvelope(result, 404, 'AI_PROFILE_NOT_FOUND');
    });

    it('returns 404 when the PERSONAL profile belongs to another user', async () => {
      mockSend.mockResolvedValue({ Items: [] });

      const result = asResult(
        await handler(
          event({ method: 'GET', aiProfileId: PROFILE_ID, sub: OTHER_ID }),
        ),
      );

      expectEnvelope(result, 404, 'AI_PROFILE_NOT_FOUND');
      const first = mockSend.mock.calls[0][0] as Command;
      expect(first.input.Key?.PK).toBe(`USER#${OTHER_ID}`);
    });
  });

  describe('DELETE /ai-profiles/{aiProfileId}', () => {
    it('deletes an owned PERSONAL profile and returns 204', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get') {
          return { Item: dynamoPersonal(OWNER_ID) };
        }
        if (command._op === 'Delete') {
          return {};
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'DELETE', aiProfileId: PROFILE_ID })),
      );

      expect(result.statusCode).toBe(204);
      expect(result.body).toBe('');
      const del = mockSend.mock.calls.find(
        (call) => (call[0] as Command)._op === 'Delete',
      )?.[0] as Command;
      expect(del.input.Key).toEqual({
        PK: `USER#${OWNER_ID}`,
        SK: `AIPROFILE#${PROFILE_ID}`,
      });
    });

    it('returns 403 when deleting a GENERIC_MODEL profile', async () => {
      mockSend.mockImplementation(async (command: Command) => {
        if (command._op === 'Get' && command.input.Key?.PK === `USER#${OWNER_ID}`) {
          return {};
        }
        if (
          command._op === 'Get' &&
          command.input.Key?.PK === 'AIPROFILE#GENERIC_MODEL'
        ) {
          return { Item: dynamoGeneric() };
        }
        throw new Error(`unexpected op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ method: 'DELETE', aiProfileId: GENERIC_ID })),
      );

      expectEnvelope(result, 403, 'UNAUTHORIZED');
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Delete'),
      ).toBe(false);
    });

    it('returns 404 AI_PROFILE_NOT_FOUND when deleting a missing profile', async () => {
      mockSend.mockResolvedValue({ Items: [] });

      const result = asResult(
        await handler(event({ method: 'DELETE', aiProfileId: PROFILE_ID })),
      );

      expectEnvelope(result, 404, 'AI_PROFILE_NOT_FOUND');
      expect(
        mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Delete'),
      ).toBe(false);
    });
  });

  describe('authentication', () => {
    it('returns 401 UNAUTHENTICATED when the authorizer context is missing', async () => {
      const result = asResult(await handler(event({ method: 'GET', sub: null })));

      expectEnvelope(result, 401, 'UNAUTHENTICATED');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does not treat a body userId as authenticated identity', async () => {
      const result = asResult(
        await handler(
          event({
            method: 'POST',
            body: { type: 'PERSONAL', userId: OTHER_ID },
            sub: null,
          }),
        ),
      );

      expectEnvelope(result, 401, 'UNAUTHENTICATED');
      expect(mockSend).not.toHaveBeenCalled();
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
