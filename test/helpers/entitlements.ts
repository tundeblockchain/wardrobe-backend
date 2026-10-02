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
