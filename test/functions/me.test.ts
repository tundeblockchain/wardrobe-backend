import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { AccountDeleteResult, DynamoItem, UserWipeResult } from '../../src/shared/types';

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
  BatchWriteCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'BatchWrite',
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
const WORN_ON = '2026-09-18';
const SHARE_TOKEN = 'shr_V1StGXR8_Z5jdHi6B-myT';

interface DynamoCommand {
  _op: 'Put' | 'Get' | 'Query' | 'Update' | 'Delete' | 'BatchWrite';
  input: {
    TableName?: string;
    Key?: { PK: string; SK: string };
    Item?: DynamoItem;
    ConditionExpression?: string;
    KeyConditionExpression?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
    ExclusiveStartKey?: Record<string, unknown>;
    IndexName?: string;
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
  retryable?: boolean,
): void {
  expect(result.statusCode).toBe(statusCode);
  expect(bodyOf(result)).toEqual({
    error: {
      code,
      message: expect.any(String),
      ...(retryable === undefined ? {} : { retryable }),
    },
  });
}

function userPartitionExtras(): DynamoItem[] {
  return [
    {
      PK: `USER#${OWNER_ID}`,
      SK: `EVENT#evt_item_${ITEM_ID}_READY`,
      entityType: 'JOB_EVENT',
      userId: OWNER_ID,
      eventId: `evt_item_${ITEM_ID}_READY`,
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z',
    },
    {
      PK: `USER#${OWNER_ID}`,
      SK: 'DEVICE#phone-1',
      entityType: 'DEVICE',
      userId: OWNER_ID,
      deviceId: 'phone-1',
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z',
    },
  ];
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

function dynamoWornOn(userId = OWNER_ID): DynamoItem {
  return {
    PK: `WARDROBE#${WARDROBE_ID}`,
    SK: `OUTFIT#${OUTFIT_ID}#WORN#${WORN_ON}`,
    entityType: 'WORN_ON',
    userId,
    wardrobeId: WARDROBE_ID,
    outfitId: OUTFIT_ID,
    wornOn: WORN_ON,
    createdAt: '2026-09-18T19:10:00.000Z',
    updatedAt: '2026-09-18T19:10:00.000Z',
  };
}

function dynamoShare(userId = OWNER_ID): DynamoItem {
  return {
    PK: `SHARE#${SHARE_TOKEN}`,
    SK: 'SHARE',
    GSI1PK: `SHARE#USER#${userId}`,
    GSI1SK: `SHARE#${SHARE_TOKEN}`,
    entityType: 'SHARE',
    userId,
    wardrobeId: WARDROBE_ID,
    resourceType: 'ITEM',
    itemId: ITEM_ID,
    token: SHARE_TOKEN,
    expiresAt: '2026-10-19T12:00:00.000Z',
    createdAt: '2026-09-19T12:00:00.000Z',
    updatedAt: '2026-09-19T12:00:00.000Z',
    ttl: 1_774_000_000,
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
    if (command._op === 'Delete' || command._op === 'BatchWrite' || command._op === 'Put') {
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

function mockPopulatedWipe(
  options: { includeProfile?: boolean; includeEntitlement?: boolean } = {},
) {
  mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
    if (command._op === 'Query') {
      const pk = command.input.ExpressionAttributeValues?.[':pk'];
      const sk = command.input.ExpressionAttributeValues?.[':sk'];
      if (
        command.input.IndexName === 'GSI1' &&
        pk === `SHARE#USER#${OWNER_ID}` &&
        sk === 'SHARE#'
      ) {
        return { Items: [dynamoShare()] };
      }
      if (pk === `USER#${OWNER_ID}` && sk === 'ENTITLEMENT') {
        return {
          Items: options.includeEntitlement
            ? [
                {
                  PK: `USER#${OWNER_ID}`,
                  SK: 'ENTITLEMENT',
                  entityType: 'ENTITLEMENT',
                  userId: OWNER_ID,
                  tier: 'PREMIUM',
                  status: 'ACTIVE',
                  createdAt: '2026-09-16T00:00:00.000Z',
                  updatedAt: '2026-09-16T00:00:00.000Z',
                },
              ]
            : [],
        };
      }
      if (pk === `USER#${OWNER_ID}` && !sk) {
        const items: DynamoItem[] = [dynamoWardrobe(), ...userPartitionExtras()];
        if (options.includeProfile) {
          items.push(dynamoProfile());
        }
        if (options.includeEntitlement) {
          items.push({
            PK: `USER#${OWNER_ID}`,
            SK: 'ENTITLEMENT',
            entityType: 'ENTITLEMENT',
            userId: OWNER_ID,
            tier: 'PREMIUM',
            status: 'ACTIVE',
            createdAt: '2026-09-16T00:00:00.000Z',
            updatedAt: '2026-09-16T00:00:00.000Z',
          });
        }
        return { Items: items };
      }
      if (pk === `USER#${OWNER_ID}` && sk === 'EVENT#') {
        return { Items: [userPartitionExtras()[0]] };
      }
      if (pk === `USER#${OWNER_ID}` && sk === 'DEVICE#') {
        return { Items: [userPartitionExtras()[1]] };
      }
      if (pk === `USER#${OWNER_ID}` && sk === 'WARDROBE#') {
        return { Items: [dynamoWardrobe()] };
      }
      if (pk === `WARDROBE#${WARDROBE_ID}`) {
        return { Items: [dynamoItem(), dynamoOutfit(), dynamoWornOn()] };
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
      if (
        options.includeEntitlement &&
        command.input.Key?.PK === `USER#${OWNER_ID}` &&
        command.input.Key?.SK === 'ENTITLEMENT'
      ) {
        return {
          Item: {
            PK: `USER#${OWNER_ID}`,
            SK: 'ENTITLEMENT',
            entityType: 'ENTITLEMENT',
            userId: OWNER_ID,
            tier: 'PREMIUM',
            status: 'ACTIVE',
            createdAt: '2026-09-16T00:00:00.000Z',
            updatedAt: '2026-09-16T00:00:00.000Z',
          },
        };
      }
      return {};
    }
    if (command._op === 'Delete' || command._op === 'BatchWrite' || command._op === 'Put') {
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
  const keys: Array<{ PK: string; SK: string }> = [];
  for (const call of mockDynamoSend.mock.calls) {
    const command = call[0] as DynamoCommand;
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

function deleteMe(
  extraDeps: Parameters<typeof handler>[1] = {},
  path: '/me' | '/me/content' = '/me',
) {
  return handler(event({ path }), {
    deleteAuthUser: jest.fn().mockResolvedValue(undefined),
    ...extraDeps,
  });
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
    it('does not cancel or revoke entitlement (WARDROBE-103 leaves content-delete unchanged)', async () => {
      mockPopulatedWipe({ includeProfile: true, includeEntitlement: true });
      const cancelSubscription = jest.fn();

      const result = asResult(
        await handler(event({ path: '/me/content' }), { cancelSubscription }),
      );

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
      expect(bodyOf(result)).not.toHaveProperty('deleted');
      expect(bodyOf(result)).not.toHaveProperty('entitlementRevoked');
      expect(bodyOf(result)).not.toHaveProperty('subscription');
      expect(cancelSubscription).not.toHaveBeenCalled();
      expect(deletedKeys()).toEqual(
        expect.arrayContaining([
          { PK: `WARDROBE#${WARDROBE_ID}`, SK: `ITEM#${ITEM_ID}` },
          { PK: `WARDROBE#${WARDROBE_ID}`, SK: `OUTFIT#${OUTFIT_ID}` },
          {
            PK: `WARDROBE#${WARDROBE_ID}`,
            SK: `OUTFIT#${OUTFIT_ID}#WORN#${WORN_ON}`,
          },
          { PK: `USER#${OWNER_ID}`, SK: `WARDROBE#${WARDROBE_ID}` },
          { PK: `USER#${OWNER_ID}`, SK: `EVENT#evt_item_${ITEM_ID}_READY` },
          { PK: `USER#${OWNER_ID}`, SK: 'DEVICE#phone-1' },
          { PK: `SHARE#${SHARE_TOKEN}`, SK: 'SHARE' },
        ]),
      );
      expect(deletedKeys()).not.toContainEqual({
        PK: `USER#${OWNER_ID}`,
        SK: 'ENTITLEMENT',
      });
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
        if (command._op === 'Delete' || command._op === 'BatchWrite') {
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

  describe('DELETE /me (WARDROBE-154)', () => {
    it('wipes data, deletes Firebase Auth, and returns { deleted: true }', async () => {
      mockPopulatedWipe({ includeProfile: true, includeEntitlement: true });
      const cancelSubscription = jest.fn().mockResolvedValue({
        status: 'CANCELED',
        cancelMode: 'IMMEDIATE',
        store: 'STRIPE',
      });
      const deleteAuthUser = jest.fn().mockResolvedValue(undefined);

      const result = asResult(
        await deleteMe({ cancelSubscription, deleteAuthUser }),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual<AccountDeleteResult>({ deleted: true });
      expect(cancelSubscription).toHaveBeenCalledWith({
        userId: OWNER_ID,
        entitlement: expect.objectContaining({
          userId: OWNER_ID,
          tier: 'PREMIUM',
          status: 'ACTIVE',
        }),
      });
      expect(deleteAuthUser).toHaveBeenCalledWith(OWNER_ID);
      expect(deletedKeys()).toEqual(
        expect.arrayContaining([
          { PK: `USER#${OWNER_ID}`, SK: `WARDROBE#${WARDROBE_ID}` },
          { PK: `WARDROBE#${WARDROBE_ID}`, SK: `ITEM#${ITEM_ID}` },
          { PK: `WARDROBE#${WARDROBE_ID}`, SK: `OUTFIT#${OUTFIT_ID}` },
          {
            PK: `WARDROBE#${WARDROBE_ID}`,
            SK: `OUTFIT#${OUTFIT_ID}#WORN#${WORN_ON}`,
          },
          { PK: `USER#${OWNER_ID}`, SK: 'PROFILE' },
          { PK: `USER#${OWNER_ID}`, SK: 'ENTITLEMENT' },
          { PK: `SHARE#${SHARE_TOKEN}`, SK: 'SHARE' },
          { PK: `USER#${OWNER_ID}`, SK: 'DELETION' },
        ]),
      );
      const puts = mockDynamoSend.mock.calls
        .map((call) => call[0] as DynamoCommand)
        .filter((command) => command._op === 'Put');
      expect(puts.some((command) => command.input.Item?.SK === 'DELETION')).toBe(
        true,
      );
    });

    it('is idempotent when the account is already empty and Auth is gone', async () => {
      mockEmptyWipe();
      const deleteAuthUser = jest.fn().mockResolvedValue(undefined);

      const first = asResult(await deleteMe({ deleteAuthUser }));
      const second = asResult(await deleteMe({ deleteAuthUser }));

      expect(bodyOf(first)).toEqual({ deleted: true });
      expect(bodyOf(second)).toEqual({ deleted: true });
      expect(deleteAuthUser).toHaveBeenCalledTimes(2);
    });

    it('retries after a data-step failure and then finishes', async () => {
      const deleteAuthUser = jest.fn().mockResolvedValue(undefined);
      mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
        if (command._op === 'Query') {
          return { Items: [] };
        }
        if (command._op === 'Get') {
          return {};
        }
        if (command._op === 'Delete' || command._op === 'BatchWrite' || command._op === 'Put') {
          return {};
        }
        throw new Error(`unexpected Dynamo op ${command._op}`);
      });
      mockS3Send
        .mockRejectedValueOnce(new Error('S3 unavailable'))
        .mockResolvedValue({ Contents: [], IsTruncated: false });

      const failed = asResult(await deleteMe({ deleteAuthUser }));
      expectEnvelope(failed, 500, 'ACCOUNT_DELETION_FAILED', true);
      expect(deleteAuthUser).not.toHaveBeenCalled();

      const retried = asResult(await deleteMe({ deleteAuthUser }));
      expect(retried.statusCode).toBe(200);
      expect(bodyOf(retried)).toEqual({ deleted: true });
      expect(deleteAuthUser).toHaveBeenCalledWith(OWNER_ID);
    });

    it('treats Firebase auth/user-not-found as success', async () => {
      mockEmptyWipe();
      const deleteAuthUser = jest.fn().mockResolvedValue(undefined);

      const result = asResult(await deleteMe({ deleteAuthUser }));

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ deleted: true });
      expect(deleteAuthUser).toHaveBeenCalledWith(OWNER_ID);
    });

    it('surfaces S3 failure as ACCOUNT_DELETION_FAILED and does not delete Auth', async () => {
      mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
        if (command._op === 'Query') {
          return { Items: [] };
        }
        if (
          command._op === 'Get' ||
          command._op === 'Delete' ||
          command._op === 'BatchWrite' ||
          command._op === 'Put'
        ) {
          return {};
        }
        throw new Error(`unexpected Dynamo op ${command._op}`);
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
      const deleteAuthUser = jest.fn();

      const result = asResult(await deleteMe({ deleteAuthUser }));

      expectEnvelope(result, 500, 'ACCOUNT_DELETION_FAILED', true);
      expect(deleteAuthUser).not.toHaveBeenCalled();
    });

    it('surfaces Auth delete failure as AUTH_DELETION_FAILED after data is gone', async () => {
      mockPopulatedWipe({ includeProfile: true, includeEntitlement: true });
      const deleteAuthUser = jest.fn().mockRejectedValue(new Error('admin down'));

      const result = asResult(await deleteMe({ deleteAuthUser }));

      expectEnvelope(result, 502, 'AUTH_DELETION_FAILED', true);
      expect(deletedKeys()).toEqual(
        expect.arrayContaining([
          { PK: `USER#${OWNER_ID}`, SK: 'ENTITLEMENT' },
          { PK: `USER#${OWNER_ID}`, SK: `WARDROBE#${WARDROBE_ID}` },
        ]),
      );
      expect(deletedKeys()).not.toContainEqual({
        PK: `USER#${OWNER_ID}`,
        SK: 'DELETION',
      });
    });

    it('still deletes AWS data when store cancel fails (App Store has no server cancel)', async () => {
      mockPopulatedWipe({ includeProfile: true, includeEntitlement: true });
      const cancelSubscription = jest.fn().mockResolvedValue({
        status: 'CANCEL_FAILED',
        store: 'APP_STORE',
        retryInStore: true,
      });
      const deleteAuthUser = jest.fn().mockResolvedValue(undefined);

      const result = asResult(
        await deleteMe({ cancelSubscription, deleteAuthUser }),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ deleted: true });
      expect(deletedKeys()).toContainEqual({
        PK: `USER#${OWNER_ID}`,
        SK: 'ENTITLEMENT',
      });
      expect(deleteAuthUser).toHaveBeenCalledWith(OWNER_ID);
    });

    it('still deletes when the cancel client throws', async () => {
      mockPopulatedWipe({ includeEntitlement: true });
      const cancelSubscription = jest.fn().mockRejectedValue(new Error('stripe down'));
      const deleteAuthUser = jest.fn().mockResolvedValue(undefined);

      const result = asResult(
        await deleteMe({ cancelSubscription, deleteAuthUser }),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ deleted: true });
      expect(deleteAuthUser).toHaveBeenCalledWith(OWNER_ID);
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
          if (pk === `USER#${OWNER_ID}` && (!sk || sk === 'AIPROFILE#')) {
            return { Items: [personal] };
          }
          return { Items: [] };
        }
        if (
          command._op === 'Get' ||
          command._op === 'Delete' ||
          command._op === 'BatchWrite' ||
          command._op === 'Put'
        ) {
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

    it('wipes shopping-link cache rows under USER# / SHOPPING#', async () => {
      const cache: DynamoItem = {
        PK: `USER#${OWNER_ID}`,
        SK: `SHOPPING#${ITEM_ID}`,
        entityType: 'SHOPPING_CACHE',
        userId: OWNER_ID,
        itemId: ITEM_ID,
        wardrobeId: WARDROBE_ID,
        cacheKey: 'abc',
        keywords: ['black tee'],
        links: [{ title: 'Tee', url: 'https://example.com' }],
        ttl: 1_800_000_000,
        createdAt: '2026-09-16T00:00:00.000Z',
        updatedAt: '2026-09-16T00:00:00.000Z',
      };

      mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
        if (command._op === 'Query') {
          const pk = command.input.ExpressionAttributeValues?.[':pk'];
          const sk = command.input.ExpressionAttributeValues?.[':sk'];
          if (pk === `USER#${OWNER_ID}` && (!sk || sk === 'SHOPPING#')) {
            return { Items: [cache] };
          }
          return { Items: [] };
        }
        if (
          command._op === 'Get' ||
          command._op === 'Delete' ||
          command._op === 'BatchWrite' ||
          command._op === 'Put'
        ) {
          return {};
        }
        throw new Error(`unexpected Dynamo op ${command._op}`);
      });
      mockS3Send.mockResolvedValue({ Contents: [], IsTruncated: false });

      const result = asResult(await handler(event({ path: '/me/content' })));

      expect(result.statusCode).toBe(200);
      expect(deletedKeys()).toContainEqual({
        PK: `USER#${OWNER_ID}`,
        SK: `SHOPPING#${ITEM_ID}`,
      });
    });

    it('does not delete another user wardrobe children even if they share a PK', async () => {
      mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
        if (command._op === 'Query') {
          const pk = command.input.ExpressionAttributeValues?.[':pk'];
          if (pk === `USER#${OWNER_ID}`) {
            return { Items: [dynamoWardrobe()] };
          }
          if (pk === `WARDROBE#${WARDROBE_ID}`) {
            return {
              Items: [
                dynamoItem(),
                dynamoItem(OTHER_ID),
                dynamoOutfit(OTHER_ID),
                dynamoWornOn(OTHER_ID),
              ],
            };
          }
          return { Items: [] };
        }
        if (
          command._op === 'Get' ||
          command._op === 'Delete' ||
          command._op === 'BatchWrite' ||
          command._op === 'Put'
        ) {
          return {};
        }
        throw new Error(`unexpected Dynamo op ${command._op}`);
      });
      mockS3Send.mockResolvedValue({ Contents: [], IsTruncated: false });

      const result = asResult(await deleteMe());

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({ deleted: true });
      expect(deletedKeys()).toContainEqual({
        PK: `WARDROBE#${WARDROBE_ID}`,
        SK: `ITEM#${ITEM_ID}`,
      });
      expect(deletedKeys()).not.toContainEqual({
        PK: `WARDROBE#${WARDROBE_ID}`,
        SK: `OUTFIT#${OUTFIT_ID}`,
      });
      expect(deletedKeys()).not.toContainEqual({
        PK: `WARDROBE#${WARDROBE_ID}`,
        SK: `OUTFIT#${OUTFIT_ID}#WORN#${WORN_ON}`,
      });
    });
  });

  describe('GET /me (WARDROBE-91)', () => {
    it('writes a Free entitlement when no row exists', async () => {
      mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
        if (command._op === 'Get') {
          return {};
        }
        if (command._op === 'Put') {
          return {};
        }
        if (command._op === 'Query') {
          return { Items: [] };
        }
        throw new Error(`unexpected Dynamo op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ path: '/me', method: 'GET' })),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({
        userId: OWNER_ID,
        tier: 'FREE',
        status: 'NONE',
        features: {
          unlimitedCatalog: false,
          aiTryOn: false,
          otherAi: false,
        },
        limits: { wardrobes: 1, items: 5, outfits: 5 },
        usage: { wardrobes: 0, items: 0, outfits: 0 },
        updatedAt: expect.any(String),
      });
      const puts = mockDynamoSend.mock.calls
        .map((call) => call[0] as DynamoCommand)
        .filter((command) => command._op === 'Put');
      expect(puts).toHaveLength(1);
      expect(puts[0].input.ConditionExpression).toBe('attribute_not_exists(PK)');
      expect(puts[0].input.Item).toEqual(
        expect.objectContaining({
          PK: `USER#${OWNER_ID}`,
          SK: 'ENTITLEMENT',
          entityType: 'ENTITLEMENT',
          userId: OWNER_ID,
          tier: 'FREE',
          status: 'NONE',
        }),
      );
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it('keeps a subscription that wins the create race', async () => {
      let entitlementReads = 0;
      mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
        if (
          command._op === 'Query' &&
          command.input.ExpressionAttributeValues?.[':sk'] === 'ENTITLEMENT'
        ) {
          entitlementReads += 1;
          if (entitlementReads === 1) {
            return { Items: [] };
          }
          return {
            Items: [
              {
                PK: `USER#${OWNER_ID}`,
                SK: 'ENTITLEMENT#2026-09-16T12:00:00.000Z#evt_sub',
                entityType: 'ENTITLEMENT',
                userId: OWNER_ID,
                tier: 'PREMIUM',
                status: 'ACTIVE',
                createdAt: '2026-09-16T12:00:00.000Z',
                updatedAt: '2026-09-16T12:00:00.000Z',
              },
            ],
          };
        }
        if (command._op === 'Put') {
          const exists = new Error('The conditional request failed');
          exists.name = 'ConditionalCheckFailedException';
          throw exists;
        }
        if (command._op === 'Query') {
          return { Items: [] };
        }
        throw new Error(`unexpected Dynamo op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ path: '/me', method: 'GET' })),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual(
        expect.objectContaining({
          tier: 'PREMIUM',
          status: 'ACTIVE',
        }),
      );
    });

    it('returns Premium with usage and omits Dynamo keys', async () => {
      mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
        if (command._op === 'Query') {
          const pk = command.input.ExpressionAttributeValues?.[':pk'];
          const sk = command.input.ExpressionAttributeValues?.[':sk'];
          if (pk === `USER#${OWNER_ID}` && sk === 'ENTITLEMENT') {
            return {
              Items: [
                {
                  PK: `USER#${OWNER_ID}`,
                  SK: 'ENTITLEMENT',
                  entityType: 'ENTITLEMENT',
                  userId: OWNER_ID,
                  tier: 'PREMIUM',
                  status: 'ACTIVE',
                  productId: 'premium_monthly',
                  store: 'APP_STORE',
                  period: 'MONTHLY',
                  createdAt: '2026-09-16T00:00:00.000Z',
                  updatedAt: '2026-09-16T12:00:00.000Z',
                },
              ],
            };
          }
          if (pk === `USER#${OWNER_ID}`) {
            return { Items: [dynamoWardrobe()] };
          }
          if (pk === `WARDROBE#${WARDROBE_ID}`) {
            return { Items: [dynamoItem(), dynamoOutfit()] };
          }
          return { Items: [] };
        }
        throw new Error(`unexpected Dynamo op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ path: '/me', method: 'GET' })),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual({
        userId: OWNER_ID,
        tier: 'PREMIUM',
        status: 'ACTIVE',
        features: {
          unlimitedCatalog: true,
          aiTryOn: true,
          otherAi: true,
        },
        limits: null,
        usage: { wardrobes: 1, items: 1, outfits: 1 },
        productId: 'premium_monthly',
        store: 'APP_STORE',
        period: 'MONTHLY',
        updatedAt: '2026-09-16T12:00:00.000Z',
      });
      expect(bodyOf(result)).not.toHaveProperty('PK');
      expect(bodyOf(result)).not.toHaveProperty('lastEventId');
      const puts = mockDynamoSend.mock.calls.filter(
        (call) => (call[0] as DynamoCommand)._op === 'Put',
      );
      expect(puts).toHaveLength(0);
    });

    it('returns the latest paid row after cancel then resubscribe', async () => {
      mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
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
                tier: 'FREE',
                status: 'NONE',
                createdAt: '2026-08-01T00:00:00.000Z',
                updatedAt: '2026-08-01T00:00:00.000Z',
              },
              {
                PK: `USER#${OWNER_ID}`,
                SK: 'ENTITLEMENT#2026-09-01T00:00:00.000Z#evt_old',
                entityType: 'ENTITLEMENT',
                userId: OWNER_ID,
                tier: 'PREMIUM',
                status: 'CANCELED',
                expiresAt: '2026-09-15T00:00:00.000Z',
                lastEventId: 'evt_old',
                createdAt: '2026-09-01T00:00:00.000Z',
                updatedAt: '2026-09-10T00:00:00.000Z',
              },
              {
                PK: `USER#${OWNER_ID}`,
                SK: 'ENTITLEMENT#2026-10-01T00:00:00.000Z#evt_resub',
                entityType: 'ENTITLEMENT',
                userId: OWNER_ID,
                tier: 'PREMIUM',
                status: 'ACTIVE',
                productId: 'premium_monthly',
                expiresAt: '2026-11-01T00:00:00.000Z',
                lastEventId: 'evt_resub',
                createdAt: '2026-10-01T00:00:00.000Z',
                updatedAt: '2026-10-01T00:00:00.000Z',
              },
            ],
          };
        }
        if (command._op === 'Query') {
          return { Items: [] };
        }
        throw new Error(`unexpected Dynamo op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ path: '/me', method: 'GET' })),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual(
        expect.objectContaining({
          tier: 'PREMIUM',
          status: 'ACTIVE',
          limits: null,
          expiresAt: '2026-11-01T00:00:00.000Z',
          productId: 'premium_monthly',
        }),
      );
    });

    it('returns Premium for B after B\'s own grant without inheriting A', async () => {
      mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
        if (
          command._op === 'Query' &&
          command.input.ExpressionAttributeValues?.[':sk'] === 'ENTITLEMENT'
        ) {
          const pk = command.input.ExpressionAttributeValues?.[':pk'];
          if (pk === `USER#${OTHER_ID}`) {
            return {
              Items: [
                {
                  PK: `USER#${OTHER_ID}`,
                  SK: 'ENTITLEMENT#2026-10-04T00:00:00.000Z#evt_b',
                  entityType: 'ENTITLEMENT',
                  userId: OTHER_ID,
                  tier: 'PREMIUM',
                  status: 'ACTIVE',
                  originalTransactionId: 'txn_account_b',
                  lastEventId: 'evt_b',
                  expiresAt: '2026-11-04T00:00:00.000Z',
                  createdAt: '2026-10-04T00:00:00.000Z',
                  updatedAt: '2026-10-04T00:00:00.000Z',
                },
              ],
            };
          }
          if (pk === `USER#${OWNER_ID}`) {
            return {
              Items: [
                {
                  PK: `USER#${OWNER_ID}`,
                  SK: 'ENTITLEMENT#2026-10-01T00:00:00.000Z#evt_a',
                  entityType: 'ENTITLEMENT',
                  userId: OWNER_ID,
                  tier: 'PREMIUM',
                  status: 'ACTIVE',
                  originalTransactionId: 'txn_account_a',
                  lastEventId: 'evt_a',
                  expiresAt: '2026-11-01T00:00:00.000Z',
                  createdAt: '2026-10-01T00:00:00.000Z',
                  updatedAt: '2026-10-01T00:00:00.000Z',
                },
              ],
            };
          }
          return { Items: [] };
        }
        if (command._op === 'Query') {
          return { Items: [] };
        }
        throw new Error(`unexpected Dynamo op ${command._op}`);
      });

      const asB = asResult(
        await handler(event({ path: '/me', method: 'GET', sub: OTHER_ID })),
      );
      expect(asB.statusCode).toBe(200);
      expect(bodyOf(asB)).toEqual(
        expect.objectContaining({
          userId: OTHER_ID,
          tier: 'PREMIUM',
          status: 'ACTIVE',
        }),
      );

      const asA = asResult(
        await handler(event({ path: '/me', method: 'GET', sub: OWNER_ID })),
      );
      expect(bodyOf(asA)).toEqual(
        expect.objectContaining({
          userId: OWNER_ID,
          tier: 'PREMIUM',
          status: 'ACTIVE',
        }),
      );
    });

    it('treats an expired Premium row as Free', async () => {
      mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
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
                tier: 'PREMIUM',
                status: 'ACTIVE',
                expiresAt: '2020-01-01T00:00:00.000Z',
                createdAt: '2019-01-01T00:00:00.000Z',
                updatedAt: '2019-01-01T00:00:00.000Z',
              },
            ],
          };
        }
        if (command._op === 'Query') {
          return { Items: [] };
        }
        throw new Error(`unexpected Dynamo op ${command._op}`);
      });

      const result = asResult(
        await handler(event({ path: '/me', method: 'GET' })),
      );

      expect(result.statusCode).toBe(200);
      expect(bodyOf(result)).toEqual(
        expect.objectContaining({
          tier: 'FREE',
          status: 'EXPIRED',
          features: { unlimitedCatalog: false, aiTryOn: false, otherAi: false },
          limits: { wardrobes: 1, items: 5, outfits: 5 },
        }),
      );
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
        await handler(event({ path: '/me', method: 'PATCH' })),
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
