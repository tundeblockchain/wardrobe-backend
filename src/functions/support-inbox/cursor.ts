import { SupportValidationError } from './http';

const STATUS_INDEX_CURSOR_KEYS = ['PK', 'SK', 'status', 'lastMessageAt'] as const;

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

  const json = decodeCursorJson(trimmed);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SupportValidationError({ cursor: 'must be a valid cursor' });
  }

  if (!isStatusIndexExclusiveStartKey(parsed)) {
    throw new SupportValidationError({ cursor: 'must be a valid cursor' });
  }

  return parsed;
}

function decodeCursorJson(cursor: string): string {
  const normalized = cursor.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new SupportValidationError({ cursor: 'must be a valid cursor' });
  }
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    throw new SupportValidationError({ cursor: 'must be a valid cursor' });
  }
}

/**
 * StatusLastMessageIndex ExclusiveStartKey: table PK/SK plus the GSI
 * keys. Wrong shape used to reach DynamoDB and 500.
 */
export function isStatusIndexExclusiveStartKey(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return STATUS_INDEX_CURSOR_KEYS.every((key) => {
    const field = record[key];
    return typeof field === 'string' && field.trim().length > 0;
  });
}
