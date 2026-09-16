import { DynamoItem, SubscriptionTier } from '../../src/shared/types';

/** Test fixture for USER#{uid} / ENTITLEMENT (WARDROBE-91). */
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
  input?: { Key?: { SK?: string } };
}): boolean {
  return command._op === 'Get' && command.input?.Key?.SK === 'ENTITLEMENT';
}
