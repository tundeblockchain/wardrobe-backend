import { deleteItem, getOwnedWardrobe, keys, putItem } from '../../shared/dynamodb';
import { assertCanCreateCatalog, isPremium } from '../../shared/entitlements';
import { newItemId, nowIso } from '../../shared/ids';
import { logger } from '../../shared/logger';
import { enqueueProcessWardrobeItem } from '../../shared/sqs';
import {
  ClothingCategory,
  ClothingItem,
  DynamoItem,
  ProcessingStatus,
} from '../../shared/types';
import { toClothingItem } from './dto';

const CREATE_PROCESSING_STATUS: ProcessingStatus = 'PENDING';

/**
 * Fields accepted by the server-side clothing-item create path.
 * Wish acquire (WARDROBE-244) builds the same record after the item-cap check.
 */
export interface NewClothingItemFields {
  userId: string;
  wardrobeId: string;
  name: string;
  category: ClothingCategory;
  imageKey: string;
  subcategory?: string;
  colours?: string[];
  brand?: string;
  acquiredAt?: string;
  itemId?: string;
}

/**
 * Wardrobe ownership + catalog item-cap. Same gate as `POST .../items`.
 * Callers that still need to copy S3 or transact should use this first so a
 * cap failure mutates nothing.
 */
export async function prepareNewClothingItem(
  userId: string,
  wardrobeId: string,
): Promise<{ enqueueAi: boolean }> {
  await getOwnedWardrobe(userId, wardrobeId);
  const entitlement = await assertCanCreateCatalog(userId, 'item');
  return { enqueueAi: isPremium(entitlement) };
}

export function buildNewClothingItem(
  fields: NewClothingItemFields,
  enqueueAi: boolean,
): DynamoItem {
  const itemId = fields.itemId ?? newItemId();
  const timestamp = nowIso();
  const item: DynamoItem = {
    PK: keys.wardrobePk(fields.wardrobeId),
    SK: keys.itemSk(itemId),
    entityType: 'ITEM',
    userId: fields.userId,
    wardrobeId: fields.wardrobeId,
    itemId,
    name: fields.name,
    category: fields.category,
    originalKey: fields.imageKey,
    processingStatus: enqueueAi ? CREATE_PROCESSING_STATUS : 'READY',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (fields.subcategory) {
    item.subcategory = fields.subcategory;
  }
  if (fields.colours) {
    item.colours = fields.colours;
  }
  if (fields.brand) {
    item.brand = fields.brand;
  }
  if (fields.acquiredAt) {
    item.acquiredAt = fields.acquiredAt;
  }
  return item;
}

export async function enqueueCreateItemProcessing(
  item: DynamoItem,
): Promise<void> {
  await enqueueProcessWardrobeItem({
    userId: String(item.userId),
    wardrobeId: String(item.wardrobeId),
    itemId: String(item.itemId),
    originalImageKey: String(item.originalKey),
  });
}

export async function deleteCreatedItem(item: DynamoItem): Promise<void> {
  await deleteItem(
    keys.wardrobePk(String(item.wardrobeId)),
    keys.itemSk(String(item.itemId)),
  );
}

/**
 * Normal create: put the item, then enqueue AI for Premium. Rolls the item
 * back if SendMessage fails so the client can retry without an orphan.
 */
export async function persistNewClothingItem(
  fields: NewClothingItemFields,
): Promise<ClothingItem> {
  const { enqueueAi } = await prepareNewClothingItem(
    fields.userId,
    fields.wardrobeId,
  );
  const item = buildNewClothingItem(fields, enqueueAi);
  await putItem(item);

  if (enqueueAi) {
    try {
      await enqueueCreateItemProcessing(item);
    } catch (error) {
      try {
        await deleteCreatedItem(item);
      } catch (compensateError) {
        logger.error('Failed to roll back item after enqueue failure', {
          itemId: item.itemId,
          wardrobeId: fields.wardrobeId,
          error:
            compensateError instanceof Error
              ? compensateError.message
              : 'unknown',
        });
      }
      throw error;
    }
  }

  return toClothingItem(item);
}
