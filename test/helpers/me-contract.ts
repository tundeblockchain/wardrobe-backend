/**
 * Snapshot of GET /me fields that shipped before WARDROBE-188.
 * Additive keys (e.g. `paidTier`) must not appear here.
 */
export const GET_ME_EXISTING_REQUIRED_FIELDS = [
  'userId',
  'tier',
  'status',
  'features',
  'limits',
  'usage',
  'updatedAt',
] as const;

export const GET_ME_EXISTING_OPTIONAL_FIELDS = [
  'productId',
  'store',
  'period',
  'expiresAt',
] as const;

export const GET_ME_EXISTING_FEATURE_KEYS = [
  'unlimitedCatalog',
  'aiTryOn',
  'otherAi',
] as const;

export const GET_ME_EXISTING_TIER_VALUES = ['FREE', 'BASIC', 'PREMIUM'] as const;
export const GET_ME_EXISTING_STATUS_VALUES = [
  'NONE',
  'ACTIVE',
  'CANCELED',
  'BILLING_ISSUE',
  'PAUSED',
  'EXPIRED',
] as const;
export const GET_ME_EXISTING_STORE_VALUES = [
  'APP_STORE',
  'PLAY_STORE',
  'STRIPE',
  'UNKNOWN',
] as const;
export const GET_ME_EXISTING_PERIOD_VALUES = [
  'MONTHLY',
  'YEARLY',
  'UNKNOWN',
] as const;

export function existingMeFieldSnapshot(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const key of GET_ME_EXISTING_REQUIRED_FIELDS) {
    snapshot[key] = body[key];
  }
  for (const key of GET_ME_EXISTING_OPTIONAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      snapshot[key] = body[key];
    }
  }
  return snapshot;
}

export function assertExistingMeContract(body: Record<string, unknown>): void {
  for (const key of GET_ME_EXISTING_REQUIRED_FIELDS) {
    expect(body).toHaveProperty(key);
  }

  expect(typeof body.userId).toBe('string');
  expect(GET_ME_EXISTING_TIER_VALUES).toContain(body.tier);
  expect(GET_ME_EXISTING_STATUS_VALUES).toContain(body.status);
  expect(typeof body.updatedAt).toBe('string');

  expect(body.features).toEqual(
    expect.objectContaining({
      unlimitedCatalog: expect.any(Boolean),
      aiTryOn: expect.any(Boolean),
      otherAi: expect.any(Boolean),
    }),
  );
  expect(Object.keys(body.features as object).sort()).toEqual(
    [...GET_ME_EXISTING_FEATURE_KEYS].sort(),
  );

  if (body.limits === null) {
    expect(body.tier).not.toBe('FREE');
  } else {
    expect(body.limits).toEqual({
      wardrobes: expect.any(Number),
      items: expect.any(Number),
      outfits: expect.any(Number),
    });
  }

  expect(body.usage).toEqual({
    wardrobes: expect.any(Number),
    items: expect.any(Number),
    outfits: expect.any(Number),
  });

  if (body.productId !== undefined) {
    expect(typeof body.productId).toBe('string');
  }
  if (body.store !== undefined) {
    expect(GET_ME_EXISTING_STORE_VALUES).toContain(body.store);
  }
  if (body.period !== undefined) {
    expect(GET_ME_EXISTING_PERIOD_VALUES).toContain(body.period);
  }
  if (body.expiresAt !== undefined) {
    expect(typeof body.expiresAt).toBe('string');
  }
}
