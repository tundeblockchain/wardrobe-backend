import { SupportValidationError } from './http';

/**
 * Opaque pagination cursor: standard base64 of the DynamoDB
 * LastEvaluatedKey JSON. Callers must treat it as opaque.
 */
export function encodeExclusiveStartKey(
  key: Record<string, unknown> | undefined,
): string | null {
  if (!key || Object.keys(key).length === 0) {
    return null;
  }
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64');
}

export function decodeExclusiveStartKey(
  cursor: string,
): Record<string, unknown> {
  const trimmed = cursor.trim();
  if (!trimmed) {
    throw new SupportValidationError({ cursor: 'must be a valid cursor' });
  }

  let json: string;
  try {
    json = Buffer.from(trimmed, 'base64').toString('utf8');
  } catch {
    throw new SupportValidationError({ cursor: 'must be a valid cursor' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SupportValidationError({ cursor: 'must be a valid cursor' });
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed as Record<string, unknown>).length === 0
  ) {
    throw new SupportValidationError({ cursor: 'must be a valid cursor' });
  }

  return parsed as Record<string, unknown>;
}
