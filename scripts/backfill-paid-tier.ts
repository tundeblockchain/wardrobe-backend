/**
 * Idempotent paid-tier backfill (WARDROBE-188).
 *
 * Fills `source` (`ios` | `android` | `stripe`) from the existing `store`
 * attribute on ENTITLEMENT rows. Fills `tier` only when that attribute is
 * missing or not FREE/BASIC/PREMIUM, using the stored productId heuristic.
 * Does not change `updatedAt`.
 *
 * Dry-run by default. Pass `--apply` to write.
 *
 *   TABLE_NAME=wardrobe-app-prod npm run backfill:paid-tier
 *   STAGE=prod npm run backfill:paid-tier -- --apply
 *
 * Requires AWS credentials that can Scan and UpdateItem on the table.
 * GET /me already derives `paidTier.source` on read, so clients do not
 * wait on this script. Re-running after `--apply` reports updated: 0.
 */

import { backfillPaidTierRecords } from '../src/shared/paid-tier-backfill';

function resolveTableName(): string {
  if (process.env.TABLE_NAME?.trim()) {
    return process.env.TABLE_NAME.trim();
  }
  const stage = process.env.STAGE?.trim() || 'dev';
  return `wardrobe-app-${stage}`;
}

async function main(): Promise<void> {
  process.env.TABLE_NAME = resolveTableName();
  const apply = process.argv.includes('--apply');
  const summary = await backfillPaidTierRecords({ apply });
  process.stdout.write(`${JSON.stringify({ table: process.env.TABLE_NAME, ...summary }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`backfill-paid-tier failed: ${message}\n`);
  process.exitCode = 1;
});
