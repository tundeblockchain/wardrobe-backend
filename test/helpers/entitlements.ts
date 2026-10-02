import { DynamoItem, SubscriptionTier } from '../../src/shared/types';

/** Test fixture for USER#{uid} entitlement rows (WARDROBE-91 / WARDROBE-159). */
export function dynamoEntitlement(
  userId: string,
  tier: SubscriptionTier = 'PREMIUM',
  overrides: Partial<DynamoItem> = {},
): DynamoItem {
  return {
    PK: `USER#${userId}`,
    SK: 'ENTITLEMENT',
    entityType: 'ENTITLEMENT',
    userId,
    tier,
    status: tier === 'FREE' ? 'NONE' : 'ACTIVE',
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
    ...overrides,
  };
}

export function isEntitlementGet(command: {
  _op?: string;
  input?: {
    Key?: { SK?: string };
    ExpressionAttributeValues?: Record<string, unknown>;
  };
}): boolean {
  if (command._op === 'Get') {
    const sk = command.input?.Key?.SK;
    return (
      typeof sk === 'string' &&
      (sk === 'ENTITLEMENT' || sk.startsWith('ENTITLEMENT#'))
    );
  }
  if (command._op === 'Query') {
    const sk = command.input?.ExpressionAttributeValues?.[':sk'];
    return typeof sk === 'string' && sk.startsWith('ENTITLEMENT');
  }
  return false;
}

export function entitlementReadResult(
  item?: DynamoItem | DynamoItem[],
): { Items: DynamoItem[]; Item?: DynamoItem } {
  if (!item) {
    return { Items: [] };
  }
  const items = Array.isArray(item) ? item : [item];
  return { Items: items, Item: items[0] };
}

export function entitlementUserIdFromCommand(command: {
  input?: {
    Key?: { PK?: string };
    ExpressionAttributeValues?: Record<string, unknown>;
  };
}): string | undefined {
  const pk =
    command.input?.Key?.PK ?? command.input?.ExpressionAttributeValues?.[':pk'];
  if (typeof pk === 'string' && pk.startsWith('USER#')) {
    return pk.slice('USER#'.length);
  }
  return undefined;
}

/**
 * Intercept entitlement reads so existing handler tests stay Premium by
 * default (WARDROBE-160). Pass `MISSING` for no row (resolves to Free).
 */
export function answerEntitlement<
  T extends {
    _op?: string;
    input?: {
      Key?: { PK?: string; SK?: string };
      ExpressionAttributeValues?: Record<string, unknown>;
    };
  },
>(
  impl: (command: T) => unknown | Promise<unknown>,
  tier: SubscriptionTier | 'MISSING' = 'PREMIUM',
): (command: T) => Promise<unknown> {
  return async (command: T) => {
    if (isEntitlementGet(command)) {
      if (tier === 'MISSING') {
        return entitlementReadResult();
      }
      const userId = entitlementUserIdFromCommand(command) ?? 'unknown';
      return entitlementReadResult(dynamoEntitlement(userId, tier));
    }
    return impl(command);
  };
}
