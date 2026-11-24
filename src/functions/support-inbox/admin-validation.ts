import {
  ADMIN_LIST_LIMIT_MAX,
  ADMIN_LIST_LIMIT_MIN,
  DEFAULT_ADMIN_LIST_LIMIT,
  SUPPORT_CONVERSATION_STATUSES,
  type SupportConversationStatus,
} from '../../shared/support-inbox-names';
import { decodeExclusiveStartKey, STATUS_INDEX_CURSOR_KEYS } from './cursor';
import { SupportValidationError } from './http';

export interface AdminListQuery {
  status: SupportConversationStatus;
  limit: number;
  exclusiveStartKey?: Record<string, unknown>;
}

export function parseAdminListQuery(
  params: Record<string, string | undefined> | null | undefined,
): AdminListQuery {
  const fields: Record<string, string> = {};
  const status = parseStatus(params?.status, fields);
  const limit = parseLimit(params?.limit, fields);
  let exclusiveStartKey: Record<string, unknown> | undefined;
  if (params?.cursor !== undefined && params.cursor !== '') {
    try {
      exclusiveStartKey = decodeExclusiveStartKey(
        params.cursor,
        STATUS_INDEX_CURSOR_KEYS,
      );
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
    status: status ?? 'open',
    limit: limit ?? DEFAULT_ADMIN_LIST_LIMIT,
    ...(exclusiveStartKey ? { exclusiveStartKey } : {}),
  };
}

function parseStatus(
  value: string | undefined,
  fields: Record<string, string>,
): SupportConversationStatus | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    !SUPPORT_CONVERSATION_STATUSES.includes(
      normalized as SupportConversationStatus,
    )
  ) {
    fields.status = 'must be open, replied, or closed';
    return undefined;
  }
  return normalized as SupportConversationStatus;
}

function parseLimit(
  value: string | undefined,
  fields: Record<string, string>,
): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (!/^[0-9]+$/.test(value.trim())) {
    fields.limit = `must be an integer ${ADMIN_LIST_LIMIT_MIN}..${ADMIN_LIST_LIMIT_MAX}`;
    return undefined;
  }
  const parsed = Number(value.trim());
  if (
    !Number.isInteger(parsed) ||
    parsed < ADMIN_LIST_LIMIT_MIN ||
    parsed > ADMIN_LIST_LIMIT_MAX
  ) {
    fields.limit = `must be an integer ${ADMIN_LIST_LIMIT_MIN}..${ADMIN_LIST_LIMIT_MAX}`;
    return undefined;
  }
  return parsed;
}
