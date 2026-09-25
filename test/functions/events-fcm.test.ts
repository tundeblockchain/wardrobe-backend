import { DynamoItem } from '../../src/shared/types';

const mockDynamoSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockDynamoSend })),
  },
  QueryCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Query',
    input,
  })),
  DeleteCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Delete',
    input,
  })),
  GetCommand: jest.fn(),
  PutCommand: jest.fn(),
  UpdateCommand: jest.fn(),
}));

import {
  jobDoneNotificationCopy,
  jobDonePushData,
  parseFcmServiceAccount,
  resetFcmAccessTokenCache,
  sendJobDonePush,
} from '../../src/functions/events/fcm';

const OWNER_ID = 'firebase-uid-owner';

function deviceRow(overrides: Partial<DynamoItem> = {}): DynamoItem {
  return {
    PK: `USER#${OWNER_ID}`,
    SK: 'DEVICE#iphone-1',
    entityType: 'DEVICE',
    userId: OWNER_ID,
    deviceId: 'iphone-1',
    platform: 'IOS',
    token: 'fcm-token-1',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('FCM job-done push (WARDROBE-114)', () => {
  const originalSecret = process.env.FIREBASE_FCM_SECRET_ARN;
  const originalTable = process.env.TABLE_NAME;

  beforeEach(() => {
    jest.clearAllMocks();
    resetFcmAccessTokenCache();
    process.env.TABLE_NAME = 'wardrobe-app-test';
    delete process.env.FIREBASE_FCM_SECRET_ARN;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.FIREBASE_FCM_SECRET_ARN;
    } else {
      process.env.FIREBASE_FCM_SECRET_ARN = originalSecret;
    }
    if (originalTable === undefined) {
      delete process.env.TABLE_NAME;
    } else {
      process.env.TABLE_NAME = originalTable;
    }
  });

  it('parses standard and camelCase service-account JSON', () => {
    expect(
      parseFcmServiceAccount(
        JSON.stringify({
          project_id: 'wardrobe-prod',
          client_email: 'fcm@wardrobe-prod.iam.gserviceaccount.com',
          private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
        }),
      ),
    ).toEqual({
      projectId: 'wardrobe-prod',
      clientEmail: 'fcm@wardrobe-prod.iam.gserviceaccount.com',
      privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
    });

    expect(parseFcmServiceAccount('not-json-placeholder')).toBeUndefined();
    expect(parseFcmServiceAccount('{"apiKey":"x"}')).toBeUndefined();
  });

  it('uses Virtual Try On copy for item renders', () => {
    expect(
      jobDoneNotificationCopy({
        userId: OWNER_ID,
        jobType: 'RENDER_ITEM',
        status: 'READY',
        wardrobeId: 'wd_1',
        itemId: 'item_1',
      }),
    ).toEqual({
      title: 'Try-on ready',
      body: 'Your Virtual Try On is ready to view.',
    });
  });

  it('builds a string-only deep-link data payload', () => {
    expect(
      jobDonePushData(
        {
          userId: OWNER_ID,
          jobType: 'RENDER_OUTFIT',
          status: 'READY',
          wardrobeId: 'wd_1',
          outfitId: 'outfit_1',
          renderId: 'rend_1',
          aiProfileId: 'profile_1',
        },
        'evt_render_rend_1_READY',
      ),
    ).toEqual({
      eventId: 'evt_render_rend_1_READY',
      jobType: 'RENDER_OUTFIT',
      status: 'READY',
      wardrobeId: 'wd_1',
      outfitId: 'outfit_1',
      renderId: 'rend_1',
      aiProfileId: 'profile_1',
    });
  });

  it('soft-skips when the secret ARN is missing', async () => {
    const result = await sendJobDonePush(
      {
        userId: OWNER_ID,
        jobType: 'PROCESS_WARDROBE_ITEM',
        status: 'READY',
        wardrobeId: 'wd_1',
        itemId: 'item_1',
      },
      'evt_item_item_1_READY',
    );
    expect(result).toEqual({ attempted: 0, sent: 0 });
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it('soft-skips when no device tokens are registered', async () => {
    process.env.FIREBASE_FCM_SECRET_ARN = 'arn:secret:firebase-fcm';
    mockDynamoSend.mockResolvedValue({ Items: [] });

    const result = await sendJobDonePush(
      {
        userId: OWNER_ID,
        jobType: 'PROCESS_WARDROBE_ITEM',
        status: 'READY',
        wardrobeId: 'wd_1',
        itemId: 'item_1',
      },
      'evt_item_item_1_READY',
      {
        getSecretString: async () =>
          JSON.stringify({
            project_id: 'wardrobe-prod',
            client_email: 'fcm@wardrobe-prod.iam.gserviceaccount.com',
            private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
          }),
      },
    );

    expect(result).toEqual({ attempted: 0, sent: 0 });
  });

  it('sends to registered tokens and deletes UNREGISTERED ones without throwing', async () => {
    process.env.FIREBASE_FCM_SECRET_ARN = 'arn:secret:firebase-fcm';
    mockDynamoSend.mockImplementation(async (command: { _op: string }) => {
      if (command._op === 'Query') {
        return {
          Items: [
            deviceRow(),
            deviceRow({
              SK: 'DEVICE#stale',
              deviceId: 'stale',
              token: 'dead-token',
            }),
          ],
        };
      }
      return {};
    });

    const fetchImpl = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('oauth2.googleapis.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'ya29.access' }),
          text: async () => '',
        } as Response;
      }
      if (href.includes('messages:send')) {
        const body = String(init?.body ?? '');
        if (body.includes('dead-token')) {
          return {
            ok: false,
            status: 404,
            text: async () => '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}',
            json: async () => ({}),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ name: 'projects/wardrobe-prod/messages/1' }),
          text: async () => '',
        } as Response;
      }
      throw new Error(`unexpected fetch ${href}`);
    });

    const result = await sendJobDonePush(
      {
        userId: OWNER_ID,
        jobType: 'PROCESS_WARDROBE_ITEM',
        status: 'READY',
        wardrobeId: 'wd_1',
        itemId: 'item_1',
      },
      'evt_item_item_1_READY',
      {
        getSecretString: async () =>
          JSON.stringify({
            project_id: 'wardrobe-prod',
            client_email: 'fcm@wardrobe-prod.iam.gserviceaccount.com',
            private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
          }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        signJwt: async () => 'signed.jwt',
      },
    );

    expect(result).toEqual({ attempted: 2, sent: 1 });
    const deletes = mockDynamoSend.mock.calls
      .map((call) => call[0] as { _op: string; input?: { Key?: { SK?: string } } })
      .filter((command) => command._op === 'Delete');
    expect(deletes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: expect.objectContaining({
            Key: { PK: `USER#${OWNER_ID}`, SK: 'DEVICE#stale' },
          }),
        }),
      ]),
    );
  });
});
