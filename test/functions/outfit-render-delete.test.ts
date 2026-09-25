import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DynamoItem } from '../../src/shared/types';

const mockSend = jest.fn();
const mockS3Send = jest.fn();

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
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'GetObject',
    input,
  })),
  PutObjectCommand: jest.fn(),
  ListObjectsV2Command: jest.fn(),
  DeleteObjectsCommand: jest.fn(),
  DeleteObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'DeleteObject',
    input,
  })),
}));

import { handler } from '../../src/functions/outfits/handler';

const OWNER_ID = 'firebase-uid-owner';
const OTHER_ID = 'firebase-uid-other';
const WARDROBE_ID = 'wd_abc123xyz0';
const OUTFIT_ID = 'outfit_xyz123ab';
const PROFILE_ID = 'profile_generic_01';
const OLD_KEY = `users/${OWNER_ID}/outfits/${OUTFIT_ID}/render.png`;
const NEW_KEY = `users/${OWNER_ID}/outfits/${OUTFIT_ID}/renders/rend_new1abcd.png`;

interface Command {
  _op: 'Put' | 'Get' | 'Query' | 'Update' | 'Delete';
  input: {
    TableName?: string;
    Item?: DynamoItem;
    Key?: { PK: string; SK: string };
    UpdateExpression?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
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

function historyOutfit(overrides: Partial<DynamoItem> = {}): DynamoItem {
  return {
    PK: `WARDROBE#${WARDROBE_ID}`,
    SK: `OUTFIT#${OUTFIT_ID}`,
    entityType: 'OUTFIT',
    userId: OWNER_ID,
    wardrobeId: WARDROBE_ID,
    outfitId: OUTFIT_ID,
    name: 'Friday Night',
    items: [{ itemId: 'item_top123abcd', slot: 'TOP' }],
    render: {
      status: 'READY',
      aiProfileId: PROFILE_ID,
      imageKey: NEW_KEY,
    },
    renderHistory: [
      {
        imageKey: OLD_KEY,
        createdAt: '2026-09-10T08:00:00.000Z',
        aiProfileId: PROFILE_ID,
      },
      {
        imageKey: NEW_KEY,
        createdAt: '2026-09-11T08:00:00.000Z',
        aiProfileId: PROFILE_ID,
      },
    ],
    createdAt: '2026-09-03T19:10:00.000Z',
    updatedAt: '2026-09-11T08:00:00.000Z',
    ...overrides,
  };
}

function event(options: {
  method?: string;
  wardrobeId?: string;
  outfitId?: string;
  body?: unknown;
  rawBody?: string;
  sub?: string | null;
}): APIGatewayProxyEventV2 {
  const wardrobeId = options.wardrobeId ?? WARDROBE_ID;
  const outfitId = options.outfitId ?? OUTFIT_ID;
  const method = options.method ?? 'DELETE';
  const authorizer =
    options.sub === null
      ? undefined
      : {
          lambda: { sub: options.sub ?? OWNER_ID },
        };
  const rawPath = `/wardrobes/${wardrobeId}/outfits/${outfitId}/renders`;
  const routeKey = `${method} /wardrobes/{wardrobeId}/outfits/{outfitId}/renders`;

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
    pathParameters: { wardrobeId, outfitId },
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

function mockOwnedOutfit(item: DynamoItem | undefined) {
  mockSend.mockImplementation(async (command: Command) => {
    if (command._op === 'Get' && command.input.Key?.SK?.startsWith('WARDROBE#')) {
      return { Item: dynamoWardrobe() };
    }
    if (command._op === 'Get' && command.input.Key?.SK?.startsWith('OUTFIT#')) {
      return item ? { Item: item } : {};
    }
    if (command._op === 'Update') {
      return { Attributes: item ?? {} };
    }
    throw new Error(`unexpected op ${command._op}`);
  });
}

function updateCommand(): Command {
  const update = mockSend.mock.calls.find(
    (call) => (call[0] as Command)._op === 'Update',
  )?.[0] as Command | undefined;
  if (!update) {
    throw new Error('expected an Update command');
  }
  return update;
}

function expectS3Delete(imageKey: string) {
  expect(mockS3Send).toHaveBeenCalledWith(
    expect.objectContaining({
      _op: 'DeleteObject',
      input: {
        Bucket: 'wardrobe-media-test',
        Key: imageKey,
      },
    }),
  );
}

describe('DELETE /wardrobes/{wardrobeId}/outfits/{outfitId}/renders (WARDROBE-149)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
    process.env.MEDIA_BUCKET_NAME = 'wardrobe-media-test';
    mockS3Send.mockResolvedValue({});
  });

  afterEach(() => {
    delete process.env.TABLE_NAME;
    delete process.env.MEDIA_BUCKET_NAME;
  });

  it('removes a history entry and deletes the S3 object', async () => {
    mockOwnedOutfit(historyOutfit());

    const result = asResult(
      await handler(event({ body: { imageKey: OLD_KEY, userId: OTHER_ID } })),
    );

    expect(result.statusCode).toBe(204);
    expect(result.body).toBe('');

    const update = updateCommand();
    expect(update.input.ExpressionAttributeValues?.[':renderHistory']).toEqual([
      {
        imageKey: NEW_KEY,
        createdAt: '2026-09-11T08:00:00.000Z',
        aiProfileId: PROFILE_ID,
      },
    ]);
    expect(update.input.ExpressionAttributeValues).not.toHaveProperty(':render');
    expect(update.input.Key).toEqual({
      PK: `WARDROBE#${WARDROBE_ID}`,
      SK: `OUTFIT#${OUTFIT_ID}`,
    });
    expectS3Delete(OLD_KEY);
    expect(
      mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Delete'),
    ).toBe(false);
  });

  it('falls back to the newest remaining history entry when deleting the hero', async () => {
    mockOwnedOutfit(historyOutfit());

    const result = asResult(await handler(event({ body: { imageKey: NEW_KEY } })));

    expect(result.statusCode).toBe(204);

    const update = updateCommand();
    expect(update.input.ExpressionAttributeValues?.[':renderHistory']).toEqual([
      {
        imageKey: OLD_KEY,
        createdAt: '2026-09-10T08:00:00.000Z',
        aiProfileId: PROFILE_ID,
      },
    ]);
    expect(update.input.ExpressionAttributeValues?.[':render']).toEqual({
      status: 'READY',
      aiProfileId: PROFILE_ID,
      imageKey: OLD_KEY,
    });
    expectS3Delete(NEW_KEY);
  });

  it('returns 204 when the imageKey is already gone', async () => {
    const goneKey = `users/${OWNER_ID}/outfits/${OUTFIT_ID}/renders/rend_gone1abcd.png`;
    mockOwnedOutfit(historyOutfit());

    const result = asResult(await handler(event({ body: { imageKey: goneKey } })));

    expect(result.statusCode).toBe(204);
    expect(
      mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Update'),
    ).toBe(false);
    expectS3Delete(goneKey);
  });

  it('returns 404 OUTFIT_NOT_FOUND for a missing outfit', async () => {
    mockOwnedOutfit(undefined);

    const result = asResult(await handler(event({ body: { imageKey: NEW_KEY } })));

    expectEnvelope(result, 404, 'OUTFIT_NOT_FOUND');
    expect(
      mockSend.mock.calls.some((call) => (call[0] as Command)._op === 'Update'),
    ).toBe(false);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('rejects a missing imageKey with VALIDATION_ERROR', async () => {
    const result = asResult(await handler(event({ body: {} })));

    expectEnvelope(result, 400, 'VALIDATION_ERROR');
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('refuses a key outside the outfit render prefix', async () => {
    const result = asResult(
      await handler(
        event({
          body: { imageKey: `users/${OWNER_ID}/uploads/photo.jpg` },
        }),
      ),
    );

    expectEnvelope(result, 400, 'VALIDATION_ERROR');
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('clears current READY render when the last history photo is deleted', async () => {
    mockOwnedOutfit(
      historyOutfit({
        renderHistory: [
          {
            imageKey: NEW_KEY,
            createdAt: '2026-09-11T08:00:00.000Z',
            aiProfileId: PROFILE_ID,
          },
        ],
      }),
    );

    const result = asResult(await handler(event({ body: { imageKey: NEW_KEY } })));

    expect(result.statusCode).toBe(204);
    const update = updateCommand();
    expect(update.input.UpdateExpression).toMatch(/REMOVE/);
    expect(update.input.ExpressionAttributeNames).toEqual(
      expect.objectContaining({
        '#renderHistory': 'renderHistory',
        '#render': 'render',
      }),
    );
    expect(update.input.ExpressionAttributeValues).not.toHaveProperty(':render');
    expectS3Delete(NEW_KEY);
  });

  it('does not wipe an in-flight PENDING render when deleting history', async () => {
    mockOwnedOutfit(
      historyOutfit({
        render: { status: 'PENDING', aiProfileId: PROFILE_ID, renderId: 'rend_inflight' },
      }),
    );

    const result = asResult(await handler(event({ body: { imageKey: OLD_KEY } })));

    expect(result.statusCode).toBe(204);
    const update = updateCommand();
    expect(update.input.ExpressionAttributeValues?.[':renderHistory']).toEqual([
      {
        imageKey: NEW_KEY,
        createdAt: '2026-09-11T08:00:00.000Z',
        aiProfileId: PROFILE_ID,
      },
    ]);
    expect(update.input.ExpressionAttributeValues).not.toHaveProperty(':render');
    expect(update.input.UpdateExpression).not.toMatch(/REMOVE.*#render(?!History)/);
    expectS3Delete(OLD_KEY);
  });
});
