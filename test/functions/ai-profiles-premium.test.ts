import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DynamoItem, SubscriptionTier } from '../../src/shared/types';

const mockSend = jest.fn();
const mockGetSignedUrl = jest.fn();
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

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'GetObject',
    input,
  })),
  PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'PutObject',
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
  DeleteObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'DeleteObject',
    input,
  })),
}));

import { handler } from '../../src/functions/ai-profiles/handler';
import { buildGenericModelProfile } from '../../src/functions/ai-profiles/model';
import {
  answerEntitlement,
  dynamoEntitlement,
  entitlementReadResult,
  isEntitlementGet,
} from '../helpers/entitlements';

const OWNER_ID = 'firebase-uid-owner';
const PROFILE_ID = 'profile_abc123xy';
const GENERIC_ID = 'profile_model0001';
const GENERIC_IMAGE_KEY = 'models/generic/model-a.png';
const REF_KEY = `users/${OWNER_ID}/ai-profiles/${PROFILE_ID}/front.jpg`;
const AI_REQUIRED_MESSAGE =
  'Virtual Try On and other AI features require Premium.';

interface Command {
  _op: 'Put' | 'Get' | 'Query' | 'Update' | 'Delete';
  input: {
    Item?: DynamoItem;
    Key?: { PK: string; SK: string };
    IndexName?: string;
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

function dynamoPersonal(overrides: Partial<DynamoItem> = {}): DynamoItem {
  return {
    PK: `USER#${OWNER_ID}`,
    SK: `AIPROFILE#${PROFILE_ID}`,
    entityType: 'AIPROFILE',
    userId: OWNER_ID,
    aiProfileId: PROFILE_ID,
    type: 'PERSONAL',
    referenceImages: [REF_KEY],
    mainImageKey: REF_KEY,
    status: 'READY',
    createdAt: '2026-09-06T08:00:00.000Z',
    updatedAt: '2026-09-06T08:00:00.000Z',
    ...overrides,
  };
}

function dynamoGeneric(): DynamoItem {
  return buildGenericModelProfile({
    aiProfileId: GENERIC_ID,
    referenceImages: [GENERIC_IMAGE_KEY],
    status: 'READY',
    createdAt: '2026-09-06T07:00:00.000Z',
    updatedAt: '2026-09-06T07:00:00.000Z',
  });
}

function event(options: {
  method: string;
  aiProfileId?: string;
  models?: boolean;
  suffix?: 'uploads' | 'reference-images' | 'reference-images/main';
  query?: Record<string, string>;
  body?: unknown;
}): APIGatewayProxyEventV2 {
  const suffix = options.suffix ? `/${options.suffix}` : '';
  const path = options.models
    ? '/ai-profiles/models'
    : options.aiProfileId
      ? `/ai-profiles/${options.aiProfileId}${suffix}`
      : '/ai-profiles';
  const route = options.models
    ? `${options.method} /ai-profiles/models`
    : options.aiProfileId
      ? `${options.method} /ai-profiles/{aiProfileId}${suffix}`
      : `${options.method} /ai-profiles`;
  const query = options.query ?? {};

  return {
    version: '2.0',
    routeKey: route,
    rawPath: path,
    rawQueryString: new URLSearchParams(query).toString(),
    headers: { authorization: 'Bearer unused-in-handler' },
    queryStringParameters: Object.keys(query).length > 0 ? query : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
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
      authorizer: { lambda: { sub: OWNER_ID } },
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function mockTier(
  tier: SubscriptionTier | 'MISSING',
  impl: (command: Command) => unknown | Promise<unknown> = () => ({}),
): void {
  mockSend.mockImplementation(answerEntitlement(impl, tier));
}

function mockOwnedPersonal(tier: SubscriptionTier | 'MISSING'): void {
  mockTier(tier, async (command) => {
    if (command._op === 'Get' && command.input.Key?.PK === `USER#${OWNER_ID}`) {
      return { Item: dynamoPersonal() };
    }
    if (command._op === 'Update') {
      return { Attributes: dynamoPersonal() };
    }
    if (command._op === 'Delete' || command._op === 'Put') {
      return {};
    }
    if (command._op === 'Query') {
      return { Items: [dynamoPersonal()] };
    }
    throw new Error(`unexpected op ${command._op}`);
  });
}

const PERSONAL_PATHS: Array<{ name: string; req: Parameters<typeof event>[0] }> = [
  { name: 'POST create PERSONAL', req: { method: 'POST', body: {} } },
  { name: 'GET list PERSONAL', req: { method: 'GET' } },
  { name: 'GET list ?type=PERSONAL', req: { method: 'GET', query: { type: 'PERSONAL' } } },
  { name: 'GET single PERSONAL', req: { method: 'GET', aiProfileId: PROFILE_ID } },
  {
    name: 'PATCH PERSONAL',
    req: { method: 'PATCH', aiProfileId: PROFILE_ID, body: { label: 'Home' } },
  },
  { name: 'DELETE PERSONAL', req: { method: 'DELETE', aiProfileId: PROFILE_ID } },
  {
    name: 'POST PERSONAL uploads',
    req: {
      method: 'POST',
      aiProfileId: PROFILE_ID,
      suffix: 'uploads',
      body: { contentType: 'image/jpeg' },
    },
  },
  {
    name: 'POST PERSONAL attach',
    req: {
      method: 'POST',
      aiProfileId: PROFILE_ID,
      suffix: 'reference-images',
      body: { objectKey: REF_KEY },
    },
  },
  {
    name: 'PATCH PERSONAL set-main',
    req: {
      method: 'PATCH',
      aiProfileId: PROFILE_ID,
      suffix: 'reference-images/main',
      body: { objectKey: REF_KEY },
    },
  },
  {
    name: 'DELETE PERSONAL gallery photo',
    req: {
      method: 'DELETE',
      aiProfileId: PROFILE_ID,
      suffix: 'reference-images',
      body: { objectKey: REF_KEY },
    },
  },
];

describe('ai-profiles Premium assert (WARDROBE-160)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
    process.env.MEDIA_BUCKET_NAME = 'wardrobe-media-test';
    mockGetSignedUrl.mockResolvedValue('https://signed.example/key');
    mockS3Send.mockResolvedValue({ Contents: [], IsTruncated: false });
  });

  afterEach(() => {
    delete process.env.TABLE_NAME;
    delete process.env.MEDIA_BUCKET_NAME;
  });

  describe.each(['FREE', 'BASIC'] as const)('%s callers', (tier) => {
    it.each(PERSONAL_PATHS)(
      'rejects $name with ENTITLEMENT_AI_REQUIRED',
      async ({ req }) => {
        mockOwnedPersonal(tier === 'FREE' ? 'MISSING' : tier);

        const result = asResult(await handler(event(req)));

        expectEnvelope(result, 403, 'ENTITLEMENT_AI_REQUIRED');
        expect((bodyOf(result) as { error: { message: string } }).error.message).toBe(
          AI_REQUIRED_MESSAGE,
        );
        expect(
          mockSend.mock.calls.some((call) =>
            ['Put', 'Update', 'Delete'].includes((call[0] as Command)._op),
          ),
        ).toBe(false);
      },
    );
  });

  it('lets Premium create and list PERSONAL profiles', async () => {
    mockOwnedPersonal('PREMIUM');

    const created = asResult(await handler(event({ method: 'POST', body: {} })));
    expect(created.statusCode).toBe(201);
    expect((bodyOf(created) as { type: string }).type).toBe('PERSONAL');

    const listed = asResult(await handler(event({ method: 'GET' })));
    expect(listed.statusCode).toBe(200);
    expect((bodyOf(listed) as { aiProfiles: unknown[] }).aiProfiles).toHaveLength(1);
  });

  it('lets Premium get and mutate an owned PERSONAL profile', async () => {
    mockOwnedPersonal('PREMIUM');

    const got = asResult(
      await handler(event({ method: 'GET', aiProfileId: PROFILE_ID })),
    );
    expect(got.statusCode).toBe(200);
    expect((bodyOf(got) as { aiProfileId: string }).aiProfileId).toBe(PROFILE_ID);

    const patched = asResult(
      await handler(
        event({
          method: 'PATCH',
          aiProfileId: PROFILE_ID,
          body: { notes: 'updated' },
        }),
      ),
    );
    expect(patched.statusCode).toBe(200);
  });

  it('does not gate GENERIC_MODEL catalog list or models for Free', async () => {
    mockSend.mockImplementation(
      answerEntitlement(async (command: Command) => {
        if (command._op === 'Query') {
          return { Items: [dynamoGeneric()] };
        }
        throw new Error(`unexpected op ${command._op}`);
      }, 'MISSING'),
    );

    const listed = asResult(
      await handler(event({ method: 'GET', query: { type: 'GENERIC_MODEL' } })),
    );
    expect(listed.statusCode).toBe(200);
    expect((bodyOf(listed) as { aiProfiles: Array<{ type: string }> }).aiProfiles[0].type).toBe(
      'GENERIC_MODEL',
    );
    expect(mockSend.mock.calls.some((call) => isEntitlementGet(call[0] as Command))).toBe(
      false,
    );

    const models = asResult(await handler(event({ method: 'GET', models: true })));
    expect(models.statusCode).toBe(200);
    expect((bodyOf(models) as { aiProfiles: unknown[] }).aiProfiles).toHaveLength(1);
  });

  it('does not gate GET single GENERIC_MODEL for Free', async () => {
    mockSend.mockImplementation(
      answerEntitlement(async (command: Command) => {
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
      }, 'MISSING'),
    );

    const result = asResult(
      await handler(event({ method: 'GET', aiProfileId: GENERIC_ID })),
    );

    expect(result.statusCode).toBe(200);
    expect((bodyOf(result) as { type: string }).type).toBe('GENERIC_MODEL');
    expect(mockSend.mock.calls.some((call) => isEntitlementGet(call[0] as Command))).toBe(
      false,
    );
  });

  it('still 404s a missing PERSONAL profile for Free before inventing a leak', async () => {
    mockSend.mockImplementation(
      answerEntitlement(async () => ({ Items: [] }), 'MISSING'),
    );

    const result = asResult(
      await handler(event({ method: 'GET', aiProfileId: PROFILE_ID })),
    );

    expectEnvelope(result, 404, 'AI_PROFILE_NOT_FOUND');
  });

  it('keeps GENERIC_MODEL mutations as UNAUTHORIZED for Free', async () => {
    mockSend.mockImplementation(
      answerEntitlement(async (command: Command) => {
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
      }, 'MISSING'),
    );

    const result = asResult(
      await handler(
        event({
          method: 'PATCH',
          aiProfileId: GENERIC_ID,
          body: { label: 'nope' },
        }),
      ),
    );

    expectEnvelope(result, 403, 'UNAUTHORIZED');
  });

  it('resolves Premium from the token UID, not a body userId', async () => {
    mockSend.mockImplementation(async (command: Command) => {
      if (isEntitlementGet(command)) {
        const pk = command.input.ExpressionAttributeValues?.[':pk'];
        expect(pk).toBe(`USER#${OWNER_ID}`);
        return entitlementReadResult(dynamoEntitlement(OWNER_ID, 'PREMIUM'));
      }
      return {};
    });

    const result = asResult(
      await handler(
        event({
          method: 'POST',
          body: { type: 'PERSONAL', userId: 'someone-else' },
        }),
      ),
    );

    expect(result.statusCode).toBe(201);
  });
});
