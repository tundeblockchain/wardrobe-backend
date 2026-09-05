const mockSend = jest.fn();

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSend })),
  GetSecretValueCommand: jest.fn().mockImplementation((input: unknown) => ({
    input,
  })),
}));

import { getSecretString, parseJsonObjectOrString } from '../../src/shared/secrets';

describe('secrets helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('parseJsonObjectOrString', () => {
    it('returns a trimmed plain string', () => {
      expect(parseJsonObjectOrString('  plain-key  ')).toBe('plain-key');
    });

    it('parses a JSON object', () => {
      expect(parseJsonObjectOrString('{"apiKey":"k","endpoint":"https://x"}')).toEqual({
        apiKey: 'k',
        endpoint: 'https://x',
      });
    });
  });

  describe('getSecretString', () => {
    it('returns the trimmed SecretString', async () => {
      mockSend.mockResolvedValue({ SecretString: '  value  ' });
      await expect(getSecretString('arn:secret')).resolves.toBe('value');
    });

    it('throws when the secret is empty', async () => {
      mockSend.mockResolvedValue({ SecretString: '   ' });
      await expect(getSecretString('arn:secret')).rejects.toThrow('Secret is empty.');
    });
  });
});
