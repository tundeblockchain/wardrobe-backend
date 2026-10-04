/**
 * Superwall webhook bodies shaped like the documented production payload
 * (https://superwall.com/docs/integrations/webhooks).
 *
 * `data` has no `appUserId`. `originalAppUserId` is the StoreKit
 * `appAccountToken` of the first purchase: the derived app user id when
 * the app identified with it, otherwise the `$SuperwallAlias:` UUID (the
 * default here, i.e. a purchase from before that app build).
 * `userAttributes` carries the SDK's `aliasId` / `seed`, `appUserId`
 * after `identify()`, and app attributes such as `firebaseUid`.
 */
export const IOS_DEVICE_ID = '7152E89E-60A6-4B2E-9C67-D7ED8F5BE372';
export const IOS_ALIAS_ID = `$SuperwallAlias:${IOS_DEVICE_ID}`;

export interface IosPurchaseOptions {
  id?: string;
  name?: string;
  originalAppUserId?: string | null;
  originalTransactionId?: string;
  transactionId?: string;
  productId?: string;
  purchasedAt?: number;
  expirationAt?: number | null;
  userAttributes?: Record<string, unknown>;
}

export function iosSuperwallEvent(options: IosPurchaseOptions = {}) {
  const name = options.name ?? 'initial_purchase';
  const purchasedAt = options.purchasedAt ?? Date.parse('2026-10-04T13:00:00.000Z');
  return {
    object: 'event',
    type: name,
    projectId: 3827,
    applicationId: 1,
    timestamp: purchasedAt + 11_000,
    data: {
      id: options.id ?? `42fc6339-dc28-470b-a0fa-0d13c92d8b61:${name}`,
      name,
      cancelReason: null,
      exchangeRate: 1.0,
      isSmallBusiness: true,
      periodType: 'NORMAL',
      countryCode: 'GB',
      price: name === 'initial_purchase' || name === 'renewal' ? 9.99 : 0,
      proceeds: name === 'initial_purchase' || name === 'renewal' ? 8.49 : 0,
      priceInPurchasedCurrency: 7.99,
      taxPercentage: 0.2,
      commissionPercentage: 0.15,
      takehomePercentage: 0.85,
      offerCode: null,
      isFamilyShare: false,
      expirationAt:
        options.expirationAt === undefined
          ? Date.parse('2026-11-04T13:00:00.000Z')
          : options.expirationAt,
      transactionId: options.transactionId ?? '700002054157982',
      originalTransactionId: options.originalTransactionId ?? '700002050981465',
      originalAppUserId:
        options.originalAppUserId === undefined
          ? IOS_ALIAS_ID
          : options.originalAppUserId,
      store: 'APP_STORE',
      purchasedAt,
      currencyCode: 'GBP',
      productId: options.productId ?? 'com.wardrobe.premium.monthly',
      environment: 'PRODUCTION',
      isTrialConversion: false,
      newProductId: null,
      bundleId: 'com.wardrobe.app',
      ts: purchasedAt + 6_000,
      userAttributes: options.userAttributes ?? superwallSdkAttributes(),
    },
  };
}

/** Attributes the Superwall SDK sets on its own, plus app extras. */
export function superwallSdkAttributes(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    aliasId: IOS_ALIAS_ID,
    seed: 42,
    applicationInstalledAt: '2026-09-20T09:14:02.000Z',
    ...extra,
  };
}
