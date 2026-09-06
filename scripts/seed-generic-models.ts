/**
 * Idempotent GENERIC_MODEL catalog seed (WARDROBE-45).
 *
 * Writes READY rows under PK=AIPROFILE#GENERIC_MODEL + GSI1 TYPE#GENERIC_MODEL.
 * Safe to re-run. Does not upload S3 images — those are placeholder keys.
 *
 *   TABLE_NAME=wardrobe-app-prod npm run seed:generic-models
 *   STAGE=prod npm run seed:generic-models
 *
 * Requires AWS credentials that can GetItem/PutItem on the table.
 */

import { getItem, putItem } from '../src/shared/dynamodb';
import { genericModelCatalog } from '../src/functions/ai-profiles/catalog';
import { seedGenericModels } from '../src/functions/ai-profiles/seed';

function resolveTableName(): string {
  if (process.env.TABLE_NAME?.trim()) {
    return process.env.TABLE_NAME.trim();
  }
  const stage = process.env.STAGE?.trim() || 'dev';
  return `wardrobe-app-${stage}`;
}

async function main(): Promise<void> {
  process.env.TABLE_NAME = resolveTableName();

  const catalog = genericModelCatalog();
  const results = await seedGenericModels({ getItem, putItem });

  process.stdout.write(
    `${JSON.stringify(
      {
        table: process.env.TABLE_NAME,
        catalogSize: catalog.length,
        results,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`seed-generic-models failed: ${message}\n`);
  process.exitCode = 1;
});
