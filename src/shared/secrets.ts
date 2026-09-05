import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const secrets = new SecretsManagerClient({});

export async function getSecretString(secretId: string): Promise<string> {
  const result = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  const value = result.SecretString?.trim();
  if (!value) {
    throw new Error('Secret is empty.');
  }
  return value;
}

/**
 * Accepts a plain string or JSON object. Used by Secrets Manager
 * placeholders that operators later replace with a real value.
 */
export function parseJsonObjectOrString(
  secretString: string,
): Record<string, unknown> | string {
  const trimmed = secretString.trim();
  if (trimmed.startsWith('{')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return trimmed;
}
