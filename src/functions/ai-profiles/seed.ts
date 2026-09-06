import { keys } from '../../shared/dynamodb';
import { nowIso as defaultNowIso } from '../../shared/ids';
import { DynamoItem } from '../../shared/types';
import {
  GENERIC_MODEL_CATALOG_CREATED_AT,
  genericModelCatalog,
} from './catalog';
import { buildGenericModelProfile } from './model';

export type SeedAction = 'created' | 'updated' | 'unchanged';

export interface SeedResult {
  aiProfileId: string;
  action: SeedAction;
  referenceImages: string[];
  label: string;
}

export interface SeedDeps {
  getItem: (pk: string, sk: string) => Promise<DynamoItem | undefined>;
  putItem: (item: DynamoItem) => Promise<void>;
  nowIso?: () => string;
}

function sameStringArray(left: unknown, right: unknown): boolean {
  const a = Array.isArray(left) ? left.map(String) : [];
  const b = Array.isArray(right) ? right.map(String) : [];
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}

export function catalogRowMatches(
  existing: DynamoItem | undefined,
  next: DynamoItem,
): boolean {
  if (!existing) {
    return false;
  }
  return (
    existing.type === next.type &&
    existing.status === next.status &&
    existing.userId === next.userId &&
    existing.entityType === next.entityType &&
    existing.GSI1PK === next.GSI1PK &&
    existing.GSI1SK === next.GSI1SK &&
    existing.label === next.label &&
    sameStringArray(existing.referenceImages, next.referenceImages)
  );
}

/**
 * Idempotent write of READY GENERIC_MODEL catalog rows.
 *
 * Re-runs preserve `createdAt` and skip Put when GSI keys, label, status,
 * and reference image keys already match. Missing GSI attributes (pre-45
 * rows) are backfilled.
 */
export async function seedGenericModels(
  deps: SeedDeps,
): Promise<SeedResult[]> {
  const nowIso = deps.nowIso ?? defaultNowIso;
  const results: SeedResult[] = [];

  for (const entry of genericModelCatalog()) {
    const existing = await deps.getItem(
      keys.genericModelPk(),
      keys.aiProfileSk(entry.aiProfileId),
    );
    const createdAt =
      typeof existing?.createdAt === 'string' && existing.createdAt
        ? existing.createdAt
        : GENERIC_MODEL_CATALOG_CREATED_AT;

    const candidate = buildGenericModelProfile({
      aiProfileId: entry.aiProfileId,
      referenceImages: entry.referenceImages,
      status: entry.status,
      label: entry.label,
      createdAt,
      updatedAt: createdAt,
    });

    if (catalogRowMatches(existing, candidate)) {
      results.push({
        aiProfileId: entry.aiProfileId,
        action: 'unchanged',
        referenceImages: entry.referenceImages,
        label: entry.label,
      });
      continue;
    }

    const next = existing
      ? { ...candidate, updatedAt: nowIso() }
      : candidate;

    await deps.putItem(next);
    results.push({
      aiProfileId: entry.aiProfileId,
      action: existing ? 'updated' : 'created',
      referenceImages: entry.referenceImages,
      label: entry.label,
    });
  }

  return results;
}
