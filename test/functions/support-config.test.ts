const mockGetSecret = jest.fn();

jest.mock('../../src/shared/secrets', () => ({
  getSecretString: (...args: unknown[]) => mockGetSecret(...args),
  parseJsonObjectOrString: jest.requireActual('../../src/shared/secrets')
    .parseJsonObjectOrString,
}));

import { loadSupportMailConfig } from '../../src/functions/support/config';

describe('loadSupportMailConfig (WARDROBE-38)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  it('prefers env overrides so tests never need Secrets Manager', async () => {
    process.env.RESEND_API_KEY = 're_env';
    process.env.RESEND_WEBHOOK_SECRET = 'whsec_env';
    process.env.SUPPORT_FROM_EMAIL = 'support@example.test';
    process.env.SUPPORT_FORWARD_TO = 'tunde@example.test';
    delete process.env.RESEND_SECRET_ARN;
    delete process.env.SUPPORT_MAIL_SECRET_ARN;

    await expect(loadSupportMailConfig()).resolves.toEqual({
      apiKey: 're_env',
      webhookSecret: 'whsec_env',
      fromEmail: 'support@example.test',
      forwardTo: 'tunde@example.test',
    });
    expect(mockGetSecret).not.toHaveBeenCalled();
  });

  it('merges the two Secrets Manager placeholders', async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_WEBHOOK_SECRET;
    delete process.env.SUPPORT_FROM_EMAIL;
    delete process.env.SUPPORT_FORWARD_TO;
    process.env.RESEND_SECRET_ARN = 'arn:resend';
    process.env.SUPPORT_MAIL_SECRET_ARN = 'arn:mail';

    mockGetSecret.mockImplementation(async (secretId: string) => {
      if (secretId === 'arn:resend') {
        return JSON.stringify({
          apiKey: 're_secret',
          webhookSecret: 'whsec_secret',
        });
      }
      return JSON.stringify({
        fromEmail: 'support@example.test',
        forwardTo: 'tunde@example.test',
      });
    });

    await expect(loadSupportMailConfig()).resolves.toEqual({
      apiKey: 're_secret',
      webhookSecret: 'whsec_secret',
      fromEmail: 'support@example.test',
      forwardTo: 'tunde@example.test',
    });
  });
});
