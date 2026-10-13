import {
  deleteManyBatched,
  getOwnedWardrobe,
  keys,
  listOwnedWardrobes,
  queryByGsi1,
  queryByPk,
} from './dynamodb';
import { Errors } from './errors';
import {
  deleteObjectsByKeys,
  deleteObjectsUnderPrefix,
  deleteObjectsUnderUserPrefix,
  itemMediaPrefix,
  outfitRenderPrefix,
  userMediaPrefix,
  wardrobeMediaPrefix,
} from './s3';
import { DynamoItem, EntityType, UserWipeResult } from './types';

export interface WipeUserOptions {
  keepAccount: boolean;
  includeEntitlement?: boolean;
  requireS3Success?: boolean;
}

interface RowKey {
  pk: string;
  sk: string;
  entityType: EntityType;
}

/**
 * Account content wipe used by DELETE /me/content and DELETE /me
 * (WARDROBE-36 / WARDROBE-154). Collects every owned row, BatchWrite-deletes
 * them (25-item chunks + UnprocessedItems retry), then best-effort wipes
 * S3 under `users/{uid}/`.
 */
export async function wipeUser(
  userId: string,
  options: WipeUserOptions,
): Promise<UserWipeResult> {
  const includeEntitlement =
    options.includeEntitlement ?? !options.keepAccount;

  const rows = await collectOwnedRows(userId, {
    includeProfile: !options.keepAccount,
    includeEntitlement,
  });

  await deleteManyBatched(rows.map(({ pk, sk }) => ({ pk, sk })));

  const s3 = await deleteObjectsUnderUserPrefix(userId);
  if (options.requireS3Success && s3.failed > 0) {
    throw Errors.accountDeletionFailed(
      'Account media could not be deleted. Please try again.',
    );
  }

  return {
    keepAccount: options.keepAccount,
    deletedWardrobes: countEntity(rows, 'WARDROBE'),
    deletedItems: countEntity(rows, 'ITEM'),
    deletedOutfits: countEntity(rows, 'OUTFIT'),
    deletedAiProfiles: countEntity(rows, 'AIPROFILE'),
    deletedS3Objects: s3.deleted,
    s3Failures: s3.failed,
  };
}

/**
 * Owner-only wardrobe cascade (WARDROBE-183). Same Dynamo batch-delete and
 * S3 list/delete helpers as `wipeUser`, scoped to one wardrobe: its row,
 * items, outfits that reference those items or the wardrobe, worn-on rows,
 * shopping-cache rows, share tokens for that wardrobe, and related
 * original / processed / cover / render objects. Other wardrobes and users
 * are not collected.
 */
export async function wipeOwnedWardrobe(
  userId: string,
  wardrobeId: string,
): Promise<void> {
  const wardrobe = await getOwnedWardrobe(userId, wardrobeId);
  const rows = await collectWardrobeCascadeRows(userId, wardrobe);
  await deleteManyBatched(rows.map((row) => ({ pk: row.PK, sk: row.SK })));
  await deleteWardrobeMedia(userId, String(wardrobe.wardrobeId), rows);
}

async function collectOwnedRows(
  userId: string,
  options: { includeProfile: boolean; includeEntitlement: boolean },
): Promise<RowKey[]> {
  const rows: RowKey[] = [];
  const seen = new Set<string>();

  const add = (pk: string, sk: string, entityType: EntityType): void => {
    const id = `${pk}\0${sk}`;
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    rows.push({ pk, sk, entityType });
  };

  const userRows = await queryByPk(keys.userPk(userId));
  for (const item of userRows) {
    if (!ownedUserPartitionRow(item, userId)) {
      continue;
    }
    if (!options.includeProfile && isProfileRow(item)) {
      continue;
    }
    if (!options.includeEntitlement && isEntitlementRow(item)) {
      continue;
    }
    add(item.PK, item.SK, item.entityType);
  }

  const shares = (
    await queryByGsi1(keys.gsi1ShareUserPk(userId), {
      skPrefix: keys.gsi1ShareSkPrefix,
    })
  ).filter((item) => item.entityType === 'SHARE' && item.userId === userId);
  for (const share of shares) {
    add(share.PK, share.SK, 'SHARE');
  }

  const wardrobes = userRows.filter(
    (item) => item.entityType === 'WARDROBE' && item.userId === userId,
  );

  for (const wardrobe of wardrobes) {
    const children = await collectWardrobePartitionRows(
      userId,
      String(wardrobe.wardrobeId),
    );
    for (const child of children) {
      add(child.PK, child.SK, child.entityType);
    }
  }

  return rows;
}

async function collectWardrobeCascadeRows(
  userId: string,
  wardrobe: DynamoItem,
): Promise<DynamoItem[]> {
  const rows: DynamoItem[] = [];
  const seen = new Set<string>();

  const add = (item: DynamoItem): void => {
    const id = `${item.PK}\0${item.SK}`;
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    rows.push(item);
  };

  add(wardrobe);

  const wardrobeId = String(wardrobe.wardrobeId);
  const children = await collectWardrobePartitionRows(userId, wardrobeId);
  for (const child of children) {
    add(child);
  }

  const itemIds = new Set(
    children
      .filter((child) => child.entityType === 'ITEM')
      .map((child) => String(child.itemId ?? ''))
      .filter((itemId) => itemId.length > 0),
  );

  const otherWardrobes = (await listOwnedWardrobes(userId)).filter(
    (item) => String(item.wardrobeId) !== wardrobeId,
  );

  for (const other of otherWardrobes) {
    const otherChildren = await collectWardrobePartitionRows(
      userId,
      String(other.wardrobeId),
    );
    const matchingOutfitIds = new Set(
      otherChildren
        .filter(
          (child) =>
            child.entityType === 'OUTFIT' &&
            (String(child.wardrobeId) === wardrobeId ||
              outfitReferencesItemIds(child, itemIds)),
        )
        .map((child) => String(child.outfitId ?? ''))
        .filter((outfitId) => outfitId.length > 0),
    );

    for (const child of otherChildren) {
      if (
        (child.entityType === 'OUTFIT' || child.entityType === 'WORN_ON') &&
        matchingOutfitIds.has(String(child.outfitId ?? ''))
      ) {
        add(child);
      }
    }
  }

  const shares = (
    await queryByGsi1(keys.gsi1ShareUserPk(userId), {
      skPrefix: keys.gsi1ShareSkPrefix,
    })
  ).filter(
    (item) =>
      item.entityType === 'SHARE' &&
      item.userId === userId &&
      String(item.wardrobeId ?? '') === wardrobeId,
  );
  for (const share of shares) {
    add(share);
  }

  return rows;
}

async function collectWardrobePartitionRows(
  userId: string,
  wardrobeId: string,
): Promise<DynamoItem[]> {
  const children = await queryByPk(keys.wardrobePk(wardrobeId));
  return children.filter((child) => child.userId === userId);
}

async function deleteWardrobeMedia(
  userId: string,
  wardrobeId: string,
  rows: DynamoItem[],
): Promise<void> {
  const prefixes = new Set<string>();
  const leftoverKeys = new Set<string>();
  collectUserScopedObjectKeys(rows, userId, leftoverKeys);

  const wardrobePrefix = tryMediaPrefix(() =>
    wardrobeMediaPrefix(userId, wardrobeId),
  );
  if (wardrobePrefix) {
    prefixes.add(wardrobePrefix);
  }

  for (const row of rows) {
    if (row.entityType === 'ITEM') {
      const prefix = tryMediaPrefix(() =>
        itemMediaPrefix(userId, String(row.itemId ?? '')),
      );
      if (prefix) {
        prefixes.add(prefix);
      }
    }
    if (row.entityType === 'OUTFIT') {
      const prefix = tryMediaPrefix(() =>
        outfitRenderPrefix(userId, String(row.outfitId ?? '')),
      );
      if (prefix) {
        prefixes.add(prefix);
      }
    }
  }

  for (const prefix of prefixes) {
    await deleteObjectsUnderPrefix(prefix, 'wardrobe media wipe');
    for (const key of leftoverKeys) {
      if (key.startsWith(prefix)) {
        leftoverKeys.delete(key);
      }
    }
  }

  if (leftoverKeys.size > 0) {
    await deleteObjectsByKeys([...leftoverKeys], 'wardrobe media wipe');
  }
}

function collectUserScopedObjectKeys(
  value: unknown,
  userId: string,
  into: Set<string>,
): void {
  const prefix = userMediaPrefix(userId);
  walkObjectKeys(value, prefix, into);
}

function walkObjectKeys(
  value: unknown,
  prefix: string,
  into: Set<string>,
): void {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      trimmed.startsWith(prefix) &&
      trimmed.length > prefix.length &&
      !trimmed.includes('..')
    ) {
      into.add(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      walkObjectKeys(entry, prefix, into);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      walkObjectKeys(entry, prefix, into);
    }
  }
}

function tryMediaPrefix(build: () => string): string | undefined {
  try {
    return build();
  } catch {
    return undefined;
  }
}

function outfitReferencesItemIds(
  outfit: DynamoItem,
  itemIds: Set<string>,
): boolean {
  if (itemIds.size === 0 || !Array.isArray(outfit.items)) {
    return false;
  }
  return outfit.items.some((entry) => {
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    const itemId = (entry as { itemId?: unknown }).itemId;
    return typeof itemId === 'string' && itemIds.has(itemId);
  });
}

function ownedUserPartitionRow(item: DynamoItem, userId: string): boolean {
  if (item.PK !== keys.userPk(userId)) {
    return false;
  }
  if (typeof item.userId === 'string' && item.userId !== userId) {
    return false;
  }
  return true;
}

function isEntitlementRow(item: DynamoItem): boolean {
  return (
    item.entityType === 'ENTITLEMENT' ||
    item.SK === keys.entitlementSk ||
    item.SK.startsWith(`${keys.entitlementSkPrefix}#`)
  );
}

function isProfileRow(item: DynamoItem): boolean {
  return item.entityType === 'PROFILE' || item.SK === keys.profileSk;
}

function countEntity(rows: RowKey[], entityType: EntityType): number {
  return rows.filter((row) => row.entityType === entityType).length;
}
