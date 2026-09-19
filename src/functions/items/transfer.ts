import {
  getOwnedItem,
  getOwnedWardrobe,
  keys,
  putItem,
  queryByPk,
  transactWrite,
} from '../../shared/dynamodb';
import { assertCanCreateCatalog } from '../../shared/entitlements';
import { Errors } from '../../shared/errors';
import { newItemId, nowIso } from '../../shared/ids';
import { DynamoItem, ProcessingStatus } from '../../shared/types';
import { requireNonEmptyString } from '../../shared/validation';

export interface TransferItemBody {
  targetWardrobeId?: unknown;
  userId?: unknown;
}

const IN_FLIGHT_STATUSES = new Set<ProcessingStatus>(['PENDING', 'PROCESSING']);

export function requireTargetWardrobeId(body: TransferItemBody): string {
  return requireNonEmptyString(body.targetWardrobeId, 'targetWardrobeId');
}

/**
 * Move keeps `itemId` and every stored attribute (images, AI metadata,
 * processing status). Dynamo PK is `WARDROBE#{wardrobeId}`, so this is a
 * transactional put-under-target + delete-from-source.
 *
 * S3 keys are user-scoped (`users/{uid}/uploads/…`,
 * `users/{uid}/items/{itemId}/processed.png`) and do not include wardrobeId.
 * The same objects stay attached — no copy, no new IAM write.
 */
export async function moveItemToWardrobe(
  userId: string,
  sourceWardrobeId: string,
  itemId: string,
  targetWardrobeId: string,
): Promise<DynamoItem> {
  const source = await loadTransferableItem(
    userId,
    sourceWardrobeId,
    itemId,
    targetWardrobeId,
  );
  await getOwnedWardrobe(userId, targetWardrobeId);
  await assertItemNotUsedInOutfits(userId, sourceWardrobeId, itemId);

  const timestamp = nowIso();
  const moved: DynamoItem = {
    ...source,
    PK: keys.wardrobePk(targetWardrobeId),
    SK: keys.itemSk(itemId),
    wardrobeId: targetWardrobeId,
    updatedAt: timestamp,
  };

  await transactWrite([
    {
      put: {
        item: moved,
        conditionExpression: 'attribute_not_exists(PK)',
      },
    },
    {
      delete: {
        pk: keys.wardrobePk(sourceWardrobeId),
        sk: keys.itemSk(itemId),
        conditionExpression: 'attribute_exists(PK)',
      },
    },
  ]);

  return moved;
}

/**
 * Copy creates a new `itemId` in the target wardrobe. Metadata, AI map,
 * processing status, and image keys are copied. S3 objects are **shared**
 * (same `originalKey` / `processedKey`) because:
 * - keys already live under `users/{uid}/` (same-user ownership)
 * - wardrobe is not part of the key
 * - item DELETE does not remove S3 objects today
 * - ItemsFn only has S3 GetObject (presign), not CopyObject
 *
 * Counts as a new catalog item — Free 5-item cap applies.
 */
export async function copyItemToWardrobe(
  userId: string,
  sourceWardrobeId: string,
  itemId: string,
  targetWardrobeId: string,
): Promise<DynamoItem> {
  const source = await loadTransferableItem(
    userId,
    sourceWardrobeId,
    itemId,
    targetWardrobeId,
  );
  await getOwnedWardrobe(userId, targetWardrobeId);
  await assertCanCreateCatalog(userId, 'item');

  const newId = newItemId();
  const timestamp = nowIso();
  const copied: DynamoItem = {
    ...source,
    PK: keys.wardrobePk(targetWardrobeId),
    SK: keys.itemSk(newId),
    itemId: newId,
    wardrobeId: targetWardrobeId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await putItem(copied);
  return copied;
}

async function loadTransferableItem(
  userId: string,
  sourceWardrobeId: string,
  itemId: string,
  targetWardrobeId: string,
): Promise<DynamoItem> {
  if (targetWardrobeId === sourceWardrobeId) {
    throw Errors.validation(
      'targetWardrobeId must be a different wardrobe than the source.',
    );
  }

  const item = await getOwnedItem(userId, sourceWardrobeId, itemId);
  assertTerminalProcessing(item);
  return item;
}

function assertTerminalProcessing(item: DynamoItem): void {
  const status = (item.processingStatus as ProcessingStatus) ?? 'READY';
  if (IN_FLIGHT_STATUSES.has(status)) {
    throw Errors.validation(
      'Item is still processing. Wait until READY or FAILED before moving or copying.',
    );
  }
}

async function assertItemNotUsedInOutfits(
  userId: string,
  wardrobeId: string,
  itemId: string,
): Promise<void> {
  const outfits = await queryByPk(keys.wardrobePk(wardrobeId), 'OUTFIT#');
  const blocking = outfits.find((outfit) => {
    if (outfit.entityType !== 'OUTFIT' || outfit.userId !== userId) {
      return false;
    }
    return outfitReferencesItem(outfit, itemId);
  });

  if (blocking) {
    throw Errors.validation(
      `Cannot move an item that is used in an outfit (${String(blocking.outfitId)}). Remove it from outfits in the source wardrobe first.`,
    );
  }
}

export function outfitReferencesItem(
  outfit: DynamoItem,
  itemId: string,
): boolean {
  const items = Array.isArray(outfit.items) ? outfit.items : [];
  return items.some((entry) => {
    if (entry === null || typeof entry !== 'object') {
      return false;
    }
    return String((entry as { itemId?: unknown }).itemId ?? '') === itemId;
  });
}
