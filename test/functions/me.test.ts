import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DynamoItem, UserWipeResult } from '../../src/shared/types';

const mockDynamoSend = jest.fn();
const mockS3Send = jest.fn();

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

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'PutObject',
    input,
  })),
  GetObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'GetObject',
    input,
  })),
  ListObjectsV2Command: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'ListObjectsV2',
    input,
  })),
  DeleteObjectsCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'DeleteObjects',
    input,
  })),
}));

import { handler } from '../../src/functions/me/handler';

const OWNER_ID = 'firebase-uid-owner';
const OTHER_ID = 'firebase-uid-other';
const WARDROBE_ID = 'wd_abc123xyz0';
const ITEM_ID = 'item_xyz123abcd';
const OUTFIT_ID = 'outfit_qwerty12';

interface DynamoCommand {
  _op: 'Put' | 'Get' | 'Query' | 'Update' | 'Delete';
  input: {
    TableName?: string;
    Key?: { PK: string; SK: string };
    KeyConditionExpression?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
    ExclusiveStartKey?: Record<string, unknown>;
  };
}

interface S3Command {
  _op: 'ListObjectsV2' | 'DeleteObjects';
  input: {
    Bucket?: string;
    Prefix?: string;
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

function dynamoItem(userId = OWNER_ID): DynamoItem {
  return {
    PK: `WARDROBE#${WARDROBE_ID}`,
    SK: `ITEM#${ITEM_ID}`,
    entityType: 'ITEM',
    userId,
    wardrobeId: WARDROBE_ID,
    itemId: ITEM_ID,
    name: 'Black T-Shirt',
    category: 'TOP',
    originalKey: `users/${userId}/uploads/photo.jpg`,
    processingStatus: 'READY',
    createdAt: '2026-09-03T18:45:00.000Z',
    updatedAt: '2026-09-03T18:45:00.000Z',
  };
}

function dynamoOutfit(userId = OWNER_ID): DynamoItem {
  return {
    PK: `WARDROBE#${WARDROBE_ID}`,
    SK: `OUTFIT#${OUTFIT_ID}`,
    entityType: 'OUTFIT',
    userId,
    wardrobeId: WARDROBE_ID,
    outfitId: OUTFIT_ID,
    name: 'Friday Night',
    items: [{ itemId: ITEM_ID, slot: 'TOP' }],
    createdAt: '2026-09-03T18:50:00.000Z',
    updatedAt: '2026-09-03T18:50:00.000Z',
  };
}

function dynamoProfile(userId = OWNER_ID): DynamoItem {
  return {
    PK: `USER#${userId}`,
    SK: 'PROFILE',
    entityType: 'PROFILE',
    userId,
    createdAt: '2026-09-03T18:00:00.000Z',
    updatedAt: '2026-09-03T18:00:00.000Z',
  };
}

function event(options: {
  path: '/me' | '/me/content';
  method?: string;
  body?: unknown;
  sub?: string | null;
}): APIGatewayProxyEventV2 {
  const method = options.method ?? 'DELETE';
  const authorizer =
    options.sub === null
      ? undefined
      : {
          lambda: { sub: options.sub ?? OWNER_ID },
        };

  return {
    version: '2.0',
    routeKey: `${method} ${options.path}`,
    rawPath: options.path,
    rawQueryString: '',
    headers: { authorization: 'Bearer unused-in-handler' },
    queryStringParameters: { userId: OTHER_ID },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'example.com',
      domainPrefix: 'example',
      http: {
        method,
        path: options.path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'jest',
      },
      requestId: 'req-1',
      routeKey: `${method} ${options.path}`,
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
      authorizer,
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function mockEmptyWipe() {
  mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
    if (command._op === 'Query') {
      return { Items: [] };
    }
    if (command._op === 'Get') {
      return {};
    }
    if (command._op === 'Delete') {
      return {};
    }
    throw new Error(`unexpected Dynamo op ${command._op}`);
  });
  mockS3Send.mockImplementation(async (command: S3Command) => {
    if (command._op === 'ListObjectsV2') {
      return { Contents: [], IsTruncated: false };
    }
    throw new Error(`unexpected S3 op ${command._op}`);
  });
}

function mockPopulatedWipe(options: { includeProfile?: boolean } = {}) {
  mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
    if (command._op === 'Query') {
      const pk = command.input.ExpressionAttributeValues?.[':pk'];
      const sk = command.input.ExpressionAttributeValues?.[':sk'];
      if (pk === `USER#${OWNER_ID}` && sk === 'WARDROBE#') {
        return { Items: [dynamoWardrobe()] };
      }
      if (pk === `WARDROBE#${WARDROBE_ID}`) {
        return { Items: [dynamoItem(), dynamoOutfit()] };
      }
      return { Items: [] };
    }
    if (command._op === 'Get') {
      if (
        options.includeProfile &&
        command.input.Key?.PK === `USER#${OWNER_ID}` &&
        command.input.Key?.SK === 'PROFILE'
      ) {
        return { Item: dynamoProfile() };
      }
      return {};
    }
    if (command._op === 'Delete') {
      return {};
    }
    throw new Error(`unexpected Dynamo op ${command._op}`);
  });

  mockS3Send.mockImplementation(async (command: S3Command) => {
    if (command._op === 'ListObjectsV2') {
      expect(command.input.Prefix).toBe(`users/${OWNER_ID}/`);
      return {
        Contents: [
          { Key: `users/${OWNER_ID}/uploads/photo.jpg` },
          { Key: `users/${OWNER_ID}/items/${ITEM_ID}/processed.png` },
        ],
        IsTruncated: false,
      };
    }
    if (command._op === 'DeleteObjects') {
      return {
        Deleted: command.input.Delete?.Objects ?? [],
      };
    }
    throw new Error(`unexpected S3 op ${command._op}`);
  });
}

function deletedKeys(): Array<{ PK: string; SK: string }> {
  return mockDynamoSend.mock.calls
    .map((call) => call[0] as DynamoCommand)
    .filter((command) => command._op === 'Delete')
    .map((command) => command.input.Key as { PK: string; SK: string });
}

describe('me handler (WARDROBE-36)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
    process.env.MEDIA_BUCKET_NAME = 'wardrobe-media-test';
  });

  afterEach(() => {
    delete process.env.TABLE_NAME;
    delete process.env.MEDIA_BUCKET_NAME;
  });

  describe('DELETE /me/content', () => {
    it('wipes owned wardrobes, items, outfits, and S3, and keeps the account', async () => {
      mockPopulatedWipe({ includeProfile: true });

      const result = asResult(await handler(event({ path: '/me/content' })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual<UserWipeResult>({
        keepAccount: true,
        deletedWardrobes: 1,
        deletedItems: 1,
        deletedOutfits: 1,
        deletedAiProfiles: 0,
        deletedS3Objects: 2,
        s3Failures: 0,
      });

      expect(deletedKeys()).toEqual(
        expect.arrayContaining([
          { PK: `WARDROBE#${WARDROBE_ID}`, SK: `ITEM#${ITEM_ID}` },
          { PK: `WARDROBE#${WARDROBE_ID}`, SK: `OUTFIT#${OUTFIT_ID}` },
          { PK: `USER#${OWNER_ID}`, SK: `WARDROBE#${WARDROBE_ID}` },
        ]),
      );
      expect(deletedKeys()).not.toContainEqual({
        PK: `USER#${OWNER_ID}`,
        SK: 'PROFILE',
      });
      expect(deletedKeys().some((key) => key.PK.includes(OTHER_ID))).toBe(false);
    });

    it('succeeds when the user already has no content', async () => {
      mockEmptyWipe();

      const result = asResult(await handler(event({ path: '/me/content' })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({
        keepAccount: true,
        deletedWardrobes: 0,
        deletedItems: 0,
        deletedOutfits: 0,
        deletedAiProfiles: 0,
        deletedS3Objects: 0,
        s3Failures: 0,
      });
      expect(deletedKeys()).toEqual([]);
    });

    it('ignores body and query userId and only wipes the token UID', async () => {
      mockPopulatedWipe();

      const result = asResult(
        await handler(
          event({
            path: '/me/content',
            body: { userId: OTHER_ID },
          }),
        ),
      );

      expect(result.statusCode).toBe(200);
      const queries = mockDynamoSend.mock.calls
        .map((call) => call[0] as DynamoCommand)
        .filter((command) => command._op === 'Query');
      expect(queries[0]?.input.ExpressionAttributeValues?.[':pk']).toBe(
        `USER#${OWNER_ID}`,
      );
      expect(queries.some((query) => JSON.stringify(query).includes(OTHER_ID))).toBe(
        false,
      );

      const lists = mockS3Send.mock.calls
        .map((call) => call[0] as S3Command)
        .filter((command) => command._op === 'ListObjectsV2');
      expect(lists[0]?.input.Prefix).toBe(`users/${OWNER_ID}/`);
    });

    it('still returns 200 when S3 cleanup is best-effort and partially fails', async () => {
      mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
        if (command._op === 'Query') {
          return { Items: [] };
        }
        return {};
      });
      mockS3Send.mockImplementation(async (command: S3Command) => {
        if (command._op === 'ListObjectsV2') {
          return {
            Contents: [{ Key: `users/${OWNER_ID}/uploads/stuck.jpg` }],
            IsTruncated: false,
          };
        }
        if (command._op === 'DeleteObjects') {
          return {
            Deleted: [],
            Errors: [
              {
                Key: `users/${OWNER_ID}/uploads/stuck.jpg`,
                Code: 'InternalError',
                Message: 'temporary',
              },
            ],
          };
        }
        throw new Error(`unexpected S3 op ${command._op}`);
      });

      const result = asResult(await handler(event({ path: '/me/content' })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual(
        expect.objectContaining({
          keepAccount: true,
          deletedS3Objects: 0,
          s3Failures: 1,
        }),
      );
    });

    it('pages Dynamo queries so a wipe does not stop at the first page', async () => {
      const secondWardrobe: DynamoItem = {
        ...dynamoWardrobe(),
        SK: 'WARDROBE#wd_second0001',
        wardrobeId: 'wd_second0001',
      };

      mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
        if (command._op === 'Query') {
          const pk = command.input.ExpressionAttributeValues?.[':pk'];
          if (pk === `USER#${OWNER_ID}` && !command.input.ExclusiveStartKey) {
            return {
              Items: [dynamoWardrobe()],
              LastEvaluatedKey: { PK: `USER#${OWNER_ID}`, SK: `WARDROBE#${WARDROBE_ID}` },
            };
          }
          if (pk === `USER#${OWNER_ID}` && command.input.ExclusiveStartKey) {
            return { Items: [secondWardrobe] };
          }
          return { Items: [] };
        }
        if (command._op === 'Delete') {
          return {};
        }
        return {};
      });
      mockS3Send.mockResolvedValue({ Contents: [], IsTruncated: false });

      const result = asResult(await handler(event({ path: '/me/content' })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual(
        expect.objectContaining({ deletedWardrobes: 2 }),
      );
      expect(deletedKeys()).toEqual(
        expect.arrayContaining([
          { PK: `USER#${OWNER_ID}`, SK: `WARDROBE#${WARDROBE_ID}` },
          { PK: `USER#${OWNER_ID}`, SK: 'WARDROBE#wd_second0001' },
        ]),
      );
    });
  });

  describe('DELETE /me', () => {
    it('wipes Dynamo + S3 including PROFILE and tells Flutter Auth remains', async () => {
      mockPopulatedWipe({ includeProfile: true });

      const result = asResult(await handler(event({ path: '/me' })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual<UserWipeResult>({
        keepAccount: false,
        deletedWardrobes: 1,
        deletedItems: 1,
        deletedOutfits: 1,
        deletedAiProfiles: 0,
        deletedS3Objects: 2,
        s3Failures: 0,
      });

      expect(deletedKeys()).toEqual(
        expect.arrayContaining([
          { PK: `USER#${OWNER_ID}`, SK: `WARDROBE#${WARDROBE_ID}` },
          { PK: `WARDROBE#${WARDROBE_ID}`, SK: `ITEM#${ITEM_ID}` },
          { PK: `WARDROBE#${WARDROBE_ID}`, SK: `OUTFIT#${OUTFIT_ID}` },
          { PK: `USER#${OWNER_ID}`, SK: 'PROFILE' },
        ]),
      );
    });

    it('succeeds when already empty so Flutter can still delete Auth', async () => {
      mockEmptyWipe();

      const result = asResult(await handler(event({ path: '/me' })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({
        keepAccount: false,
        deletedWardrobes: 0,
        deletedItems: 0,
        deletedOutfits: 0,
        deletedAiProfiles: 0,
        deletedS3Objects: 0,
        s3Failures: 0,
      });
    });

    it('wipes owned PERSONAL AI profiles and leaves GENERIC_MODEL catalog rows', async () => {
      const personal: DynamoItem = {
        PK: `USER#${OWNER_ID}`,
        SK: 'AIPROFILE#profile_mine0001',
        entityType: 'AIPROFILE',
        userId: OWNER_ID,
        aiProfileId: 'profile_mine0001',
        type: 'PERSONAL',
        referenceImages: [],
        status: 'READY',
        createdAt: '2026-09-06T08:00:00.000Z',
        updatedAt: '2026-09-06T08:00:00.000Z',
      };

      mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
        if (command._op === 'Query') {
          const pk = command.input.ExpressionAttributeValues?.[':pk'];
          const sk = command.input.ExpressionAttributeValues?.[':sk'];
          if (pk === `USER#${OWNER_ID}` && sk === 'AIPROFILE#') {
            return { Items: [personal] };
          }
          return { Items: [] };
        }
        if (command._op === 'Get' || command._op === 'Delete') {
          return {};
        }
        throw new Error(`unexpected Dynamo op ${command._op}`);
      });
      mockS3Send.mockResolvedValue({ Contents: [], IsTruncated: false });

      const result = asResult(await handler(event({ path: '/me/content' })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual(
        expect.objectContaining({ deletedAiProfiles: 1 }),
      );
      expect(deletedKeys()).toContainEqual({
        PK: `USER#${OWNER_ID}`,
        SK: 'AIPROFILE#profile_mine0001',
      });
      expect(deletedKeys().some((key) => key.PK === 'AIPROFILE#GENERIC_MODEL')).toBe(
        false,
      );
    });

    it('does not delete another user wardrobe children even if they share a PK', async () => {
      mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
        if (command._op === 'Query') {
          const pk = command.input.ExpressionAttributeValues?.[':pk'];
          if (pk === `USER#${OWNER_ID}`) {
            return { Items: [dynamoWardrobe()] };
          }
          if (pk === `WARDROBE#${WARDROBE_ID}`) {
            return { Items: [dynamoItem(), dynamoItem(OTHER_ID), dynamoOutfit(OTHER_ID)] };
          }
          return { Items: [] };
        }
        if (command._op === 'Get' || command._op === 'Delete') {
          return {};
        }
        throw new Error(`unexpected Dynamo op ${command._op}`);
      });
      mockS3Send.mockResolvedValue({ Contents: [], IsTruncated: false });

      const result = asResult(await handler(event({ path: '/me' })));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual(
        expect.objectContaining({
          deletedItems: 1,
          deletedOutfits: 0,
        }),
      );
      expect(deletedKeys()).not.toContainEqual({
        PK: `WARDROBE#${WARDROBE_ID}`,
        SK: `OUTFIT#${OUTFIT_ID}`,
      });
    });
  });

  describe('auth and errors', () => {
    it('returns 401 when the authorizer context is missing', async () => {
      const result = asResult(
        await handler(event({ path: '/me/content', sub: null })),
      );
      expectEnvelope(result, 401, 'UNAUTHENTICATED');
      expect(mockDynamoSend).not.toHaveBeenCalled();
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('returns 400 for unsupported methods', async () => {
      const result = asResult(
        await handler(event({ path: '/me', method: 'GET' })),
      );
      expectEnvelope(result, 400, 'VALIDATION_ERROR');
    });

    it('returns 500 when DynamoDB fails so a half-wipe is not reported as success', async () => {
      mockDynamoSend.mockRejectedValue(new Error('Dynamo unavailable'));

      const result = asResult(await handler(event({ path: '/me/content' })));

      expectEnvelope(result, 500, 'INTERNAL_ERROR');
      expect(mockS3Send).not.toHaveBeenCalled();
    });
  });
});
