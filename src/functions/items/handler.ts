import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import {
  deleteItem,
  getOwnedItem,
  getOwnedWardrobe,
  keys,
  putItem,
  queryByPk,
  updateAttributes,
} from '../../shared/dynamodb';
import { Errors } from '../../shared/errors';
import {
  created,
  errorResponse,
  noContent,
  ok,
  parseJsonBody,
} from '../../shared/http';
import { newItemId, nowIso } from '../../shared/ids';
import { logger } from '../../shared/logger';
import { createPresignedGetUrl } from '../../shared/s3';
import { enqueueProcessWardrobeItem } from '../../shared/sqs';
import {
  ClothingCategory,
  ClothingItem,
  ClothingItemList,
  DynamoItem,
  ProcessingStatus,
} from '../../shared/types';
import {
  optionalNonEmptyString,
  optionalStringArray,
  requireCategory,
  requireNonEmptyString,
  requireOwnedImageKey,
} from '../../shared/validation';
import {
  ItemListFilters,
  itemMatchesFilters,
  parseItemListFilters,
} from './filters';

interface CreateItemBody {
  name?: unknown;
  category?: unknown;
  subcategory?: unknown;
  colours?: unknown;
  brand?: unknown;
  imageKey?: unknown;
  userId?: unknown;
  processingStatus?: unknown;
}

interface UpdateItemBody {
  name?: unknown;
  category?: unknown;
  subcategory?: unknown;
  colours?: unknown;
  brand?: unknown;
  imageKey?: unknown;
  userId?: unknown;
  processingStatus?: unknown;
}

const CREATE_PROCESSING_STATUS: ProcessingStatus = 'PENDING';

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = getUserId(event);
    const method = event.requestContext.http.method;
    const wardrobeId = event.pathParameters?.wardrobeId?.trim();
    const itemId = event.pathParameters?.itemId?.trim();

    if (!wardrobeId) {
      throw Errors.validation('wardrobeId is required.');
    }

    if (!itemId) {
      if (method === 'GET') {
        return ok(
          await listItems(
            userId,
            wardrobeId,
            parseItemListFilters(event.queryStringParameters),
          ),
        );
      }
      if (method === 'POST') {
        return created(await createItem(userId, wardrobeId, parseJsonBody(event)));
      }
      throw Errors.validation(`Unsupported method: ${method}`);
    }

    if (method === 'GET') {
      return ok(await toClothingItem(await getOwnedItem(userId, wardrobeId, itemId)));
    }

    if (method === 'PATCH') {
      return ok(await updateItem(userId, wardrobeId, itemId, parseJsonBody(event)));
    }

    if (method === 'DELETE') {
      await removeItem(userId, wardrobeId, itemId);
      return noContent();
    }

    throw Errors.validation(`Unsupported method: ${method}`);
  } catch (error) {
    return errorResponse(error);
  }
}

async function listItems(
  userId: string,
  wardrobeId: string,
  filters: ItemListFilters,
): Promise<ClothingItemList> {
  await getOwnedWardrobe(userId, wardrobeId);
  const items = await queryByPk(keys.wardrobePk(wardrobeId), 'ITEM#');
  return {
    items: await Promise.all(
      items
        .filter(
          (item) =>
            item.entityType === 'ITEM' &&
            item.userId === userId &&
            item.wardrobeId === wardrobeId &&
            itemMatchesFilters(item, filters),
        )
        .map(toClothingItem),
    ),
  };
}

async function createItem(
  userId: string,
  wardrobeId: string,
  body: CreateItemBody,
): Promise<ClothingItem> {
  await getOwnedWardrobe(userId, wardrobeId);

  const name = requireNonEmptyString(body.name, 'name');
  const category = requireCategory(body.category);
  const imageKey = requireOwnedImageKey(body.imageKey, userId);
  const subcategory = optionalNonEmptyString(body.subcategory, 'subcategory');
  const colours = optionalStringArray(body.colours, 'colours');
  const brand = optionalNonEmptyString(body.brand, 'brand');

  const itemId = newItemId();
  const timestamp = nowIso();

  const item: DynamoItem = {
    PK: keys.wardrobePk(wardrobeId),
    SK: keys.itemSk(itemId),
    entityType: 'ITEM',
    userId,
    wardrobeId,
    itemId,
    name,
    category,
    subcategory,
    colours,
    brand,
    originalKey: imageKey,
    processingStatus: CREATE_PROCESSING_STATUS,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  // Write first, then enqueue. If SendMessage fails, roll the item back so
  // the client can retry create without an orphaned PENDING record.
  await putItem(item);

  try {
    await enqueueProcessWardrobeItem({
      userId,
      wardrobeId,
      itemId,
      originalImageKey: imageKey,
    });
  } catch (error) {
    try {
      await deleteItem(keys.wardrobePk(wardrobeId), keys.itemSk(itemId));
    } catch (compensateError) {
      logger.error('Failed to roll back item after enqueue failure', {
        itemId,
        wardrobeId,
        error:
          compensateError instanceof Error
            ? compensateError.message
            : 'unknown',
      });
    }
    throw error;
  }

  return toClothingItem(item);
}

async function updateItem(
  userId: string,
  wardrobeId: string,
  itemId: string,
  body: UpdateItemBody,
): Promise<ClothingItem> {
  await getOwnedItem(userId, wardrobeId, itemId);

  const updates: Record<string, unknown> = {};

  if (body.name !== undefined) {
    updates.name = requireNonEmptyString(body.name, 'name');
  }
  if (body.category !== undefined) {
    updates.category = requireCategory(body.category);
  }
  if (body.subcategory !== undefined) {
    updates.subcategory = requireNonEmptyString(body.subcategory, 'subcategory');
  }
  if (body.colours !== undefined) {
    const colours = optionalStringArray(body.colours, 'colours');
    if (colours === undefined) {
      throw Errors.validation('colours must be an array of strings.');
    }
    updates.colours = colours;
  }
  if (body.brand !== undefined) {
    updates.brand = requireNonEmptyString(body.brand, 'brand');
  }
  if (body.imageKey !== undefined) {
    updates.originalKey = requireOwnedImageKey(body.imageKey, userId);
  }

  if (Object.keys(updates).length === 0) {
    throw Errors.validation('At least one field is required.');
  }

  const updated = await updateAttributes(
    keys.wardrobePk(wardrobeId),
    keys.itemSk(itemId),
    { ...updates, updatedAt: nowIso() },
  );

  return toClothingItem(updated);
}

async function removeItem(
  userId: string,
  wardrobeId: string,
  itemId: string,
): Promise<void> {
  await getOwnedItem(userId, wardrobeId, itemId);
  await deleteItem(keys.wardrobePk(wardrobeId), keys.itemSk(itemId));
}

async function toClothingItem(item: DynamoItem): Promise<ClothingItem> {
  const dto: ClothingItem = {
    itemId: String(item.itemId),
    wardrobeId: String(item.wardrobeId),
    name: String(item.name),
    category: item.category as ClothingCategory,
    processingStatus: (item.processingStatus as ProcessingStatus) ?? 'READY',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };

  if (typeof item.subcategory === 'string') {
    dto.subcategory = item.subcategory;
  }
  if (Array.isArray(item.colours)) {
    dto.colours = item.colours.map(String);
  }
  if (typeof item.brand === 'string') {
    dto.brand = item.brand;
  }

  if (typeof item.originalKey === 'string') {
    dto.image = {
      originalKey: item.originalKey,
      ...(typeof item.processedKey === 'string'
        ? { processedKey: item.processedKey }
        : {}),
    };
  }

  // WARDROBE-54: Flutter reads top-level HTTPS URLs. Soft-fail so a
  // presign error cannot 500 create / list / get.
  const originalImageUrl = await signedItemImageUrl(
    item.originalKey,
    'original',
  );
  if (originalImageUrl) {
    dto.originalImageUrl = originalImageUrl;
  }

  const processedImageUrl = await signedItemImageUrl(
    item.processedKey,
    'processed',
  );
  if (processedImageUrl) {
    dto.processedImageUrl = processedImageUrl;
  }

  return dto;
}

async function signedItemImageUrl(
  objectKey: unknown,
  kind: 'original' | 'processed',
): Promise<string | undefined> {
  if (typeof objectKey !== 'string' || !objectKey.trim()) {
    return undefined;
  }

  try {
    const { imageUrl } = await createPresignedGetUrl({ objectKey });
    return imageUrl;
  } catch (error) {
    logger.warn('Failed to presign clothing-item image GET URL', {
      kind,
      objectKey,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return undefined;
  }
}
