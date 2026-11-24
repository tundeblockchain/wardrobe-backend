import {
  DEFAULT_USER_LIST_LIMIT,
  USER_LIST_LIMIT_MAX,
  USER_LIST_LIMIT_MIN,
} from '../../shared/support-inbox-names';
import { decodeExclusiveStartKey } from './cursor';
import { SupportValidationError } from './http';

export interface UserListQuery {
  limit: number;
  exclusiveStartKey?: Record<string, unknown>;
}

export function parseUserListQuery(
  params: Record<string, string | undefined> | null | undefined,
): UserListQuery {
  const fields: Record<string, string> = {};
  const limit = parseLimit(params?.limit, fields);
  let exclusiveStartKey: Record<string, unknown> | undefined;
  if (params?.cursor !== undefined && params.cursor !== '') {
    try {
      exclusiveStartKey = decodeExclusiveStartKey(params.cursor);
    } catch (error) {
      if (error instanceof SupportValidationError) {
        Object.assign(fields, error.fields);
      } else {
        fields.cursor = 'must be a valid cursor';
      }
    }
  }

  if (Object.keys(fields).length > 0) {
    throw new SupportValidationError(fields);
  }

  return {
    limit: limit ?? DEFAULT_USER_LIST_LIMIT,
    ...(exclusiveStartKey ? { exclusiveStartKey } : {}),
  };
}

function parseLimit(
  value: string | undefined,
  fields: Record<string, string>,
): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (!/^[0-9]+$/.test(value.trim())) {
    fields.limit = `must be an integer ${USER_LIST_LIMIT_MIN}..${USER_LIST_LIMIT_MAX}`;
    return undefined;
  }
  const parsed = Number(value.trim());
  if (
    !Number.isInteger(parsed) ||
    parsed < USER_LIST_LIMIT_MIN ||
    parsed > USER_LIST_LIMIT_MAX
  ) {
    fields.limit = `must be an integer ${USER_LIST_LIMIT_MIN}..${USER_LIST_LIMIT_MAX}`;
    return undefined;
  }
  return parsed;
}
