import {
  parseFcmServiceAccount,
  resetSupportFcmCache,
  sendSupportReplyPushBestEffort,
} from '../../src/functions/support-inbox/fcm';
import { hashDeviceToken } from '../../src/functions/support-inbox/model';
import { keys } from '../../src/functions/support-inbox/keys';
import {
  FCM_SERVICE_ACCOUNT_SECRET_ARN_ENV,
  SUPPORT_PUSH_TIMEOUT_MS,
  SUPPORT_REPLY_PUSH_BODY,
  SUPPORT_REPLY_PUSH_DATA_TYPE,
  SUPPORT_REPLY_PUSH_TITLE,
} from '../../src/shared/support-inbox-names';

const OWNER_UID = 'firebase-uid-owner';
const CONVERSATION_ID = 'conv_1';
const MESSAGE_ID = 'msg_admin';

function deviceRow(token: string, uid = OWNER_UID): Record<string, unknown> {
  return {
    PK: keys.devicePk(uid),
    SK: keys.deviceSk(hashDeviceToken(token)),
    entityType: 'SUPPORT_DEVICE',
    uid,
    token,
    tokenHash: hashDeviceToken(token),
    platform: 'ios',
  };
}

const SERVICE_ACCOUNT = {
  project_id: 'wardrobe-prod',
  client_email: 'fcm@wardrobe-prod.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
};

describe('support inbox FCM push (WARDROBE-286)', () => {
  const originalSecret = process.env[FCM_SERVICE_ACCOUNT_SECRET_ARN_ENV];

  beforeEach(() => {
    jest.clearAllMocks();
    resetSupportFcmCache();
    delete process.env[FCM_SERVICE_ACCOUNT_SECRET_ARN_ENV];
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env[FCM_SERVICE_ACCOUNT_SECRET_ARN_ENV];
    } else {
      process.env[FCM_SERVICE_ACCOUNT_SECRET_ARN_ENV] = originalSecret;
    }
  });

  it('parses standard and camelCase service-account JSON and rejects placeholders', () => {
    expect(parseFcmServiceAccount(JSON.stringify(SERVICE_ACCOUNT))).toEqual({
      projectId: 'wardrobe-prod',
      clientEmail: 'fcm@wardrobe-prod.iam.gserviceaccount.com',
      privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
    });
    expect(
      parseFcmServiceAccount(
        JSON.stringify({
          projectId: 'wardrobe-prod',
          clientEmail: 'fcm@wardrobe-prod.iam.gserviceaccount.com',
          privateKey:
            '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
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

  it('skips when uid, tokens, or credential are missing', async () => {
    expect(
      await sendSupportReplyPushBestEffort({
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
      }),
    ).toBe('skipped');

    process.env[FCM_SERVICE_ACCOUNT_SECRET_ARN_ENV] = 'arn:secret:fcm';
    expect(
      await sendSupportReplyPushBestEffort(
        {
          conversationId: CONVERSATION_ID,
          messageId: MESSAGE_ID,
          uid: OWNER_UID,
        },
        {
          getSecretString: async () => 'placeholder',
          listDevices: async () => [deviceRow('tok')],
        },
      ),
    ).toBe('skipped');

    resetSupportFcmCache();
    expect(
      await sendSupportReplyPushBestEffort(
        {
          conversationId: CONVERSATION_ID,
          messageId: MESSAGE_ID,
          uid: OWNER_UID,
        },
        {
          getSecretString: async () => JSON.stringify(SERVICE_ACCOUNT),
          listDevices: async () => [],
        },
      ),
    ).toBe('skipped');
  });

  it('sends FCM HTTP v1 with no message text, prunes UNREGISTERED and INVALID_ARGUMENT tokens, and records sent', async () => {
    process.env[FCM_SERVICE_ACCOUNT_SECRET_ARN_ENV] = 'arn:secret:fcm';
    const deleteDevice = jest.fn(async () => undefined);
    const fetchImpl = jest.fn(async (url: string, init?: { body?: string }) => {
      if (url.includes('oauth2.googleapis.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'ya29.access' }),
          text: async () => '',
        };
      }
      const body = String(init?.body ?? '');
      expect(body).toContain(SUPPORT_REPLY_PUSH_TITLE);
      expect(body).toContain(SUPPORT_REPLY_PUSH_BODY);
      expect(body).toContain(SUPPORT_REPLY_PUSH_DATA_TYPE);
      expect(body).toContain(CONVERSATION_ID);
      expect(body).not.toContain('Thanks for writing in.');
      expect(body).not.toContain('user@example.com');
      if (body.includes('dead-token')) {
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
          text: async () =>
            '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}',
        };
      }
      if (body.includes('invalid-token')) {
        return {
          ok: false,
          status: 400,
          json: async () => ({}),
          text: async () =>
            '{"error":{"status":"INVALID_ARGUMENT","message":"unregistered"}}',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: 'projects/wardrobe-prod/messages/1' }),
        text: async () => '',
      };
    });

    const status = await sendSupportReplyPushBestEffort(
      {
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
        uid: OWNER_UID,
      },
      {
        getSecretString: async () => JSON.stringify(SERVICE_ACCOUNT),
        listDevices: async () => [
          deviceRow('live-token'),
          deviceRow('dead-token'),
          deviceRow('invalid-token'),
        ],
        deleteDevice,
        fetchImpl,
        signJwt: async () => 'signed.jwt',
      },
    );

    expect(status).toBe('sent');
    expect(deleteDevice).toHaveBeenCalledWith(OWNER_UID, 'dead-token');
    expect(deleteDevice).toHaveBeenCalledWith(OWNER_UID, 'invalid-token');
    expect(deleteDevice).not.toHaveBeenCalledWith(OWNER_UID, 'live-token');
    expect(SUPPORT_PUSH_TIMEOUT_MS).toBe(3000);
  });

  it('returns failed without throwing when FCM send throws, and logs no PII', async () => {
    process.env[FCM_SERVICE_ACCOUNT_SECRET_ARN_ENV] = 'arn:secret:fcm';
    const log = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const status = await sendSupportReplyPushBestEffort(
      {
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
        uid: OWNER_UID,
      },
      {
        getSecretString: async () => JSON.stringify(SERVICE_ACCOUNT),
        listDevices: async () => [deviceRow('live-token')],
        signJwt: async () => 'signed.jwt',
        fetchImpl: async () => {
          throw new Error('socket hang up');
        },
        log,
      },
    );
    expect(status).toBe('failed');
    const blob = JSON.stringify(log);
    expect(blob).not.toContain(OWNER_UID);
    expect(blob).not.toContain('live-token');
    expect(blob).not.toContain('user@example.com');
    expect(blob).not.toContain(SERVICE_ACCOUNT.private_key);
  });
});
