import { scanByEntityType, updateAttributes } from './dynamodb';
import { mapProductToTier } from './entitlements';
import {
  isPaidTierSource,
  isSubscriptionTier,
  paidTierSourceFromStore,
} from './paid-tier';
import { DynamoItem, EntitlementStore } from './types';

export interface PaidTierBackfillPatch {
  source?: string;
  tier?: string;
}

export interface PaidTierBackfillRowResult {
  pk: string;
  sk: string;
  patch: PaidTierBackfillPatch | null;
}

export interface PaidTierBackfillSummary {
  scanned: number;
  updated: number;
  skipped: number;
  dryRun: boolean;
}

const STORES: readonly EntitlementStore[] = [
  'APP_STORE',
  'PLAY_STORE',
  'STRIPE',
  'UNKNOWN',
];

/**
 * Attributes to persist on an existing ENTITLEMENT row. Idempotent:
 * returns null when `source` (and `tier` when already valid) are already
 * filled. Never touches `updatedAt` — recency for GET /me must stay the
 * Superwall / grant write, not this backfill.
 */
export function paidTierBackfillPatch(
  item: DynamoItem,
): PaidTierBackfillPatch | null {
  if (item.entityType !== 'ENTITLEMENT') {
    return null;
  }

  const patch: PaidTierBackfillPatch = {};

  if (!isPaidTierSource(item.source)) {
    const store = isStore(item.store) ? item.store : undefined;
    const source = paidTierSourceFromStore(store);
    if (source) {
      patch.source = source;
    }
  }

  if (!isSubscriptionTier(item.tier)) {
    const productId =
      typeof item.productId === 'string' ? item.productId : undefined;
    const tier = mapProductToTier(productId, {}, { paidGrant: Boolean(productId) });
    if (tier) {
      patch.tier = tier;
    }
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

export function summarizePaidTierBackfill(
  rows: PaidTierBackfillRowResult[],
  dryRun: boolean,
): PaidTierBackfillSummary {
  const updated = rows.filter((row) => row.patch).length;
  return {
    scanned: rows.length,
    updated,
    skipped: rows.length - updated,
    dryRun,
  };
}

export async function applyPaidTierBackfillPatch(
  row: PaidTierBackfillRowResult,
): Promise<void> {
  if (!row.patch) {
    return;
  }
  await updateAttributes(row.pk, row.sk, { ...row.patch });
}

export function paidTierBackfillRows(
  items: DynamoItem[],
): PaidTierBackfillRowResult[] {
  return items.flatMap((item) => {
    if (item.entityType !== 'ENTITLEMENT') {
      return [];
    }
    return [
      {
        pk: item.PK,
        sk: item.SK,
        patch: paidTierBackfillPatch(item),
      },
    ];
  });
}

/**
 * Scan ENTITLEMENT rows and fill `source` (and `tier` when missing) from
 * already-stored `store` / `productId`. Safe to re-run. Default is dry-run.
 */
export async function backfillPaidTierRecords(options: {
  apply: boolean;
}): Promise<PaidTierBackfillSummary> {
  const items = await scanByEntityType('ENTITLEMENT');
  const rows = paidTierBackfillRows(items);
  if (options.apply) {
    for (const row of rows) {
      await applyPaidTierBackfillPatch(row);
    }
  }
  return summarizePaidTierBackfill(rows, !options.apply);
}

function isStore(value: unknown): value is EntitlementStore {
  return typeof value === 'string' && STORES.includes(value as EntitlementStore);
}
