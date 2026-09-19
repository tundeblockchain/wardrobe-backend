import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DynamoItem } from '../../src/shared/types';

const mockDynamoSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockDynamoSend })),
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

import { handler } from '../../src/functions/events/handler';

const OWNER_ID = 'firebase-uid-owner';
const OTHER_ID = 'firebase-uid-other';
const WARDROBE_ID = 'wd_abc123xyz0';
const ITEM_ID = 'item_xyz123abcd';
const EVENT_ID = `evt_item_${ITEM_ID}_READY`;

interface DynamoCommand {
  _op: 'Put' | 'Get' | 'Query' | 'Update' | 'Delete';
  input: {
    TableName?: string;
    Key?: { PK: string; SK: string };
    Item?: DynamoItem;
    ExpressionAttributeValues?: Record<string, unknown>;
    ConditionExpression?: string;
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

function dynamoEvent(overrides: Partial<DynamoItem> = {}): DynamoItem {
  return {
    PK: `USER#${OWNER_ID}`,
    SK: `EVENT#${EVENT_ID}`,
    entityType: 'JOB_EVENT',
    userId: OWNER_ID,
    eventId: EVENT_ID,
    jobType: 'PROCESS_WARDROBE_ITEM',
    status: 'READY',
    wardrobeId: WARDROBE_ID,
    itemId: ITEM_ID,
    createdAt: '2026-09-19T10:00:00.000Z',
    updatedAt: '2026-09-19T10:00:00.000Z',
    ttl: 1_800_000_000,
    ...overrides,
  };
}

function event(options: {
  method: string;
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  pathParameters?: Record<string, string>;
  sub?: string | null;
}): APIGatewayProxyEventV2 {
  const authorizer =
    options.sub === null
      ? undefined
      : {
          lambda: { sub: options.sub ?? OWNER_ID },
        };
  const queryEntries = Object.entries(options.query ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return {
    version: '2.0',
    routeKey: `${options.method} ${options.path}`,
    rawPath: options.path.replace(/\{[^}]+\}/g, (match) => {
      const name = match.slice(1, -1);
      return options.pathParameters?.[name] ?? match;
    }),
    rawQueryString: queryEntries
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&'),
    headers: { authorization: 'Bearer unused-in-handler' },
    queryStringParameters: options.query,
    pathParameters: options.pathParameters,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'example.com',
      domainPrefix: 'example',
      http: {
        method: options.method,
        path: options.path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'jest',
      },
      requestId: 'req-1',
      routeKey: `${options.method} ${options.path}`,
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
      authorizer,
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

describe('events handler (WARDROBE-114)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
  });

  afterEach(() => {
    delete process.env.TABLE_NAME;
  });

  describe('GET /me/events', () => {
    it('returns unread events newest first and ignores query userId', async () => {
      mockDynamoSend.mockResolvedValue({
        Items: [
          dynamoEvent({
            eventId: 'evt_item_old_READY',
            SK: 'EVENT#evt_item_old_READY',
            createdAt: '2026-09-18T10:00:00.000Z',
          }),
          dynamoEvent({
            acknowledgedAt: '2026-09-19T11:00:00.000Z',
            eventId: 'evt_item_acked_READY',
            SK: 'EVENT#evt_item_acked_READY',
            createdAt: '2026-09-19T11:00:00.000Z',
          }),
          dynamoEvent(),
        ],
      });

      const result = asResult(
        await handler(
          event({
            method: 'GET',
            path: '/me/events',
            query: { userId: OTHER_ID },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({
        events: [
          {
            eventId: EVENT_ID,
            jobType: 'PROCESS_WARDROBE_ITEM',
            status: 'READY',
            wardrobeId: WARDROBE_ID,
            itemId: ITEM_ID,
            createdAt: '2026-09-19T10:00:00.000Z',
          },
          {
            eventId: 'evt_item_old_READY',
            jobType: 'PROCESS_WARDROBE_ITEM',
            status: 'READY',
            wardrobeId: WARDROBE_ID,
            itemId: ITEM_ID,
            createdAt: '2026-09-18T10:00:00.000Z',
          },
        ],
        unreadCount: 2,
      });
    });

    it('includes acknowledged events when unreadOnly=false', async () => {
      mockDynamoSend.mockResolvedValue({
        Items: [
          dynamoEvent({
            acknowledgedAt: '2026-09-19T11:00:00.000Z',
          }),
        ],
      });

      const result = asResult(
        await handler(
          event({
            method: 'GET',
            path: '/me/events',
            query: { unreadOnly: 'false' },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({
        events: [
          {
            eventId: EVENT_ID,
            jobType: 'PROCESS_WARDROBE_ITEM',
            status: 'READY',
            wardrobeId: WARDROBE_ID,
            itemId: ITEM_ID,
            createdAt: '2026-09-19T10:00:00.000Z',
            acknowledgedAt: '2026-09-19T11:00:00.000Z',
          },
        ],
        unreadCount: 0,
      });
    });

    it('rejects an invalid limit', async () => {
      const result = asResult(
        await handler(
          event({
            method: 'GET',
            path: '/me/events',
            query: { limit: '0' },
          }),
        ),
      );
      expect(result.statusCode).toBe(400);
      expect(bodyOf(result)).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'limit must be between 1 and 50.',
        },
      });
    });
  });

  describe('POST /me/events/{eventId}/ack', () => {
    it('acks an unread event', async () => {
      mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
        if (command._op === 'Get') {
          return { Item: dynamoEvent() };
        }
        if (command._op === 'Update') {
          return {
            Attributes: dynamoEvent({
              acknowledgedAt: '2026-09-19T12:00:00.000Z',
              updatedAt: '2026-09-19T12:00:00.000Z',
            }),
          };
        }
        throw new Error(`unexpected ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            path: '/me/events/{eventId}/ack',
            pathParameters: { eventId: EVENT_ID },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toMatchObject({
        eventId: EVENT_ID,
        acknowledgedAt: '2026-09-19T12:00:00.000Z',
      });
    });

    it('is idempotent when the event is already acked', async () => {
      mockDynamoSend.mockResolvedValue({
        Item: dynamoEvent({ acknowledgedAt: '2026-09-19T11:00:00.000Z' }),
      });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            path: '/me/events/{eventId}/ack',
            pathParameters: { eventId: EVENT_ID },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(
        mockDynamoSend.mock.calls.some(
          (call) => (call[0] as DynamoCommand)._op === 'Update',
        ),
      ).toBe(false);
    });

    it('returns 404 EVENT_NOT_FOUND for another user event', async () => {
      mockDynamoSend.mockResolvedValue({ Item: undefined });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            path: '/me/events/{eventId}/ack',
            pathParameters: { eventId: EVENT_ID },
          }),
        ),
      );

      expect(result.statusCode).toBe(404);
      expect(bodyOf(result)).toEqual({
        error: {
          code: 'EVENT_NOT_FOUND',
          message: 'Job event not found.',
        },
      });
    });
  });

  describe('POST /me/events/ack', () => {
    it('acks known ids and skips missing ones', async () => {
      mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
        if (command._op === 'Get') {
          if (command.input.Key?.SK === `EVENT#${EVENT_ID}`) {
            return { Item: dynamoEvent() };
          }
          return {};
        }
        if (command._op === 'Update') {
          return {
            Attributes: dynamoEvent({
              acknowledgedAt: '2026-09-19T12:00:00.000Z',
            }),
          };
        }
        throw new Error(`unexpected ${command._op}`);
      });

      const result = asResult(
        await handler(
          event({
            method: 'POST',
            path: '/me/events/ack',
            body: { eventIds: [EVENT_ID, 'evt_item_missing_FAILED'] },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({
        events: [
          expect.objectContaining({
            eventId: EVENT_ID,
            acknowledgedAt: '2026-09-19T12:00:00.000Z',
          }),
        ],
      });
    });

    it('rejects an empty eventIds array', async () => {
      const result = asResult(
        await handler(
          event({
            method: 'POST',
            path: '/me/events/ack',
            body: { eventIds: [] },
          }),
        ),
      );
      expect(result.statusCode).toBe(400);
    });
  });

  describe('PUT /me/devices', () => {
    it('upserts an FCM token without echoing it', async () => {
      mockDynamoSend.mockResolvedValue({});

      const result = asResult(
        await handler(
          event({
            method: 'PUT',
            path: '/me/devices',
            body: {
              token: 'fcm-token-abc',
              platform: 'IOS',
              deviceId: 'iphone-1',
            },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({
        deviceId: 'iphone-1',
        platform: 'IOS',
        updatedAt: expect.any(String),
      });
      expect(JSON.stringify(bodyOf(result))).not.toContain('fcm-token-abc');
      const put = mockDynamoSend.mock.calls
        .map((call) => call[0] as DynamoCommand)
        .find((command) => command._op === 'Put');
      expect(put?.input.Item).toMatchObject({
        PK: `USER#${OWNER_ID}`,
        SK: 'DEVICE#iphone-1',
        entityType: 'DEVICE',
        token: 'fcm-token-abc',
        platform: 'IOS',
      });
    });

    it('rejects an unknown platform', async () => {
      const result = asResult(
        await handler(
          event({
            method: 'PUT',
            path: '/me/devices',
            body: { token: 'abc', platform: 'WEB' },
          }),
        ),
      );
      expect(result.statusCode).toBe(400);
      expect(bodyOf(result)).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'platform must be IOS or ANDROID.',
        },
      });
    });
  });

  describe('DELETE /me/devices/{deviceId}', () => {
    it('returns 204 when the device is missing', async () => {
      mockDynamoSend.mockResolvedValue({});

      const result = asResult(
        await handler(
          event({
            method: 'DELETE',
            path: '/me/devices/{deviceId}',
            pathParameters: { deviceId: 'iphone-1' },
          }),
        ),
      );

      expect(result.statusCode).toBe(204);
    });
  });

  it('returns 401 when the authorizer context is missing', async () => {
    const result = asResult(
      await handler(
        event({
          method: 'GET',
          path: '/me/events',
          sub: null,
        }),
      ),
    );
    expect(result.statusCode).toBe(401);
  });
});
