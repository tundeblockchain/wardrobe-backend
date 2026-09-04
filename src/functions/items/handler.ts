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
import {
  ClothingCategory,
  ClothingItem,
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

const PHASE_1_PROCESSING_STATUS: ProcessingStatus = 'READY';

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
        return ok({ items: await listItems(userId, wardrobeId) });
      }
      if (method === 'POST') {
        return created(await createItem(userId, wardrobeId, parseJsonBody(event)));
      }
      throw Errors.validation(`Unsupported method: ${method}`);
    }

    if (method === 'GET') {
      return ok(toClothingItem(await getOwnedItem(userId, wardrobeId, itemId)));
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
): Promise<ClothingItem[]> {
  await getOwnedWardrobe(userId, wardrobeId);
  const items = await queryByPk(keys.wardrobePk(wardrobeId), 'ITEM#');
  return items
    .filter(
      (item) =>
        item.entityType === 'ITEM' &&
        item.userId === userId &&
        item.wardrobeId === wardrobeId,
    )
    .map(toClothingItem);
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

  // Phase-1: persist READY and do not enqueue SQS (Phase-2 AI worker).
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
    processingStatus: PHASE_1_PROCESSING_STATUS,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await putItem(item);
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

function toClothingItem(item: DynamoItem): ClothingItem {
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

  return dto;
}
