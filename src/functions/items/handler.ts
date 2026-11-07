import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import {
  deleteItem,
  getOwnedItem,
  getOwnedItemById,
  getOwnedWardrobe,
  isConditionalCheckFailed,
  keys,
  queryByPk,
  updateAttributes,
} from '../../shared/dynamodb';
import { assertPremiumAi, isPremium, resolveEntitlement } from '../../shared/entitlements';
import { isBackgroundRemovalEnabled } from '../../shared/flags';
import { Errors } from '../../shared/errors';
import {
  accepted,
  created,
  errorResponse,
  noContent,
  ok,
  parseJsonBody,
  routeKey,
} from '../../shared/http';
import { newOutfitRenderId, nowIso } from '../../shared/ids';
import { logger } from '../../shared/logger';
import { deleteObjectBestEffort } from '../../shared/s3';
import {
  enqueueProcessWardrobeItem,
  enqueueRenderItem,
} from '../../shared/sqs';
import {
  ClothingItem,
  ClothingItemList,
  DynamoItem,
  OutfitRender,
  PROCESS_WARDROBE_ITEM_BACKGROUND_REMOVAL_ONLY,
  ProcessingStatus,
  Wish,
} from '../../shared/types';
import {
  optionalIsoDate,
  optionalNonEmptyString,
  optionalStringArray,
  parseTryOnSource,
  requireCategory,
  requireNonEmptyString,
  requireOwnedImageKey,
  requireOwnedItemRenderKey,
} from '../../shared/validation';
import {
  clothingItemImageKey,
  pendingRender,
  planRenderPhotoDelete,
  requireReadyRenderableProfile,
  seedHistoryFromCurrentRender,
  toOutfitRender,
  toRenderHistory,
  withSignedRenderUrl,
} from '../outfits/render';
import { persistNewClothingItem } from './create';
import { itemOriginalKey, toClothingItem } from './dto';
import {
  ItemListFilters,
  itemMatchesFilters,
  parseItemListFilters,
} from './filters';
import {
  copyItemToWardrobe,
  moveItemToWardrobe,
  requireTargetWardrobeId,
  TransferItemBody,
} from './transfer';
import { requestWishRender } from '../wishlist/render';

interface CreateItemBody {
  name?: unknown;
  category?: unknown;
  subcategory?: unknown;
  colours?: unknown;
  brand?: unknown;
  acquiredAt?: unknown;
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
  acquiredAt?: unknown;
  imageKey?: unknown;
  userId?: unknown;
  processingStatus?: unknown;
}

interface DeleteRenderBody {
  imageKey?: unknown;
  userId?: unknown;
}

interface RequestItemRenderBody {
  aiProfileId?: unknown;
  userId?: unknown;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = getUserId(event);
    const method = event.requestContext.http.method;
    const wardrobeId = event.pathParameters?.wardrobeId?.trim();
    const itemId = event.pathParameters?.itemId?.trim();

    if (isTryOnRoute(event)) {
      if (method !== 'POST') {
        throw Errors.validation(`Unsupported method: ${method}`);
      }
      return accepted(await requestTryOn(userId, parseJsonBody(event)));
    }

    if (!wardrobeId) {
      // WARDROBE-173: web `/app/items/:id` has no wardrobeId.
      if (method === 'GET' && itemId) {
        return ok(await toClothingItem(await getOwnedItemById(userId, itemId)));
      }
      throw Errors.validation('wardrobeId is required.');
    }

    if (isReprocessRoute(event)) {
      if (!itemId) {
        throw Errors.validation('itemId is required.');
      }
      if (method === 'POST') {
        return accepted(await reprocessItem(userId, wardrobeId, itemId));
      }
      throw Errors.validation(`Unsupported method: ${method}`);
    }

    if (isItemRendersRoute(event)) {
      if (!itemId) {
        throw Errors.validation('itemId is required.');
      }
      if (method === 'DELETE') {
        await deleteItemRenderPhoto(
          userId,
          wardrobeId,
          itemId,
          parseJsonBody(event),
        );
        return noContent();
      }
      throw Errors.validation(`Unsupported method: ${method}`);
    }

    if (isItemRenderRoute(event)) {
      if (!itemId) {
        throw Errors.validation('itemId is required.');
      }
      if (method === 'GET') {
        return ok(await getItemRender(userId, wardrobeId, itemId));
      }
      if (method === 'POST') {
        return accepted(
          await requestItemRender(
            userId,
            wardrobeId,
            itemId,
            parseJsonBody(event),
          ),
        );
      }
      throw Errors.validation(`Unsupported method: ${method}`);
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

    const transfer = itemTransferAction(event);
    if (transfer) {
      if (method !== 'POST') {
        throw Errors.validation(`Unsupported method: ${method}`);
      }
      const targetWardrobeId = requireTargetWardrobeId(
        parseJsonBody<TransferItemBody>(event),
      );
      if (transfer === 'move') {
        return ok(
          await toClothingItem(
            await moveItemToWardrobe(userId, wardrobeId, itemId, targetWardrobeId),
          ),
        );
      }
      return created(
        await toClothingItem(
          await copyItemToWardrobe(userId, wardrobeId, itemId, targetWardrobeId),
        ),
      );
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

function isTryOnRoute(event: APIGatewayProxyEventV2): boolean {
  const key = routeKey(event);
  const path = event.rawPath ?? '';
  return key.includes(' /try-on') || /\/try-on\/?$/.test(path);
}

async function requestTryOn(
  userId: string,
  body: RequestItemRenderBody & { itemId?: unknown; wishId?: unknown },
): Promise<ClothingItem | Wish> {
  const source = parseTryOnSource(body);
  if ('itemId' in source) {
    const item = await getOwnedItemById(userId, source.itemId);
    return requestItemRender(
      userId,
      String(item.wardrobeId),
      source.itemId,
      body,
    );
  }
  return requestWishRender(userId, source.wishId, body);
}

function isItemRendersRoute(event: APIGatewayProxyEventV2): boolean {
  const key = routeKey(event);
  const path = event.rawPath ?? '';
  return (
    key.includes('/items/{itemId}/renders') ||
    /\/items\/[^/]+\/renders\/?$/.test(path)
  );
}

function isReprocessRoute(event: APIGatewayProxyEventV2): boolean {
  const key = routeKey(event);
  const path = event.rawPath ?? '';
  return (
    key.includes('/items/{itemId}/reprocess') ||
    (key.includes('/reprocess') && key.includes('/items/')) ||
    /\/items\/[^/]+\/reprocess\/?$/.test(path)
  );
}

/**
 * Current poll + generate. Do not match WARDROBE-149
 * `DELETE .../items/{itemId}/renders` (plural).
 */
function isItemRenderRoute(event: APIGatewayProxyEventV2): boolean {
  const key = routeKey(event);
  const path = event.rawPath ?? '';
  return (
    (key.includes('/items/{itemId}/render') &&
      !key.includes('/items/{itemId}/renders')) ||
    /\/items\/[^/]+\/render\/?$/.test(path)
  );
}

async function getItemRender(
  userId: string,
  wardrobeId: string,
  itemId: string,
): Promise<OutfitRender> {
  const item = await getOwnedItem(userId, wardrobeId, itemId);
  const render = toOutfitRender(item.render);
  if (!render) {
    throw Errors.renderNotFound();
  }
  return withSignedRenderUrl(render);
}

async function requestItemRender(
  userId: string,
  wardrobeId: string,
  itemId: string,
  body: RequestItemRenderBody,
): Promise<ClothingItem> {
  const existing = await getOwnedItem(userId, wardrobeId, itemId);
  await assertPremiumAi(userId);
  const previousRender = existing.render;
  const aiProfileId = requireNonEmptyString(body.aiProfileId, 'aiProfileId');
  await requireReadyRenderableProfile(userId, aiProfileId);

  if (!clothingItemImageKey(existing)) {
    throw Errors.validation(`Clothing item ${itemId} has no image to render.`);
  }

  const renderId = newOutfitRenderId();
  const render = pendingRender(aiProfileId, renderId);
  const renderHistory = seedHistoryFromCurrentRender(
    toRenderHistory(existing.renderHistory),
    toOutfitRender(previousRender),
    existing.updatedAt,
  );
  const updates: Record<string, unknown> = {
    render,
    updatedAt: nowIso(),
    ...(renderHistory.length > 0 ? { renderHistory } : {}),
  };

  const updated = await updateAttributes(
    keys.wardrobePk(wardrobeId),
    keys.itemSk(itemId),
    updates,
  );

  try {
    await enqueueRenderItem({
      userId,
      wardrobeId,
      itemId,
      aiProfileId,
      renderId,
    });
  } catch (error) {
    try {
      await updateAttributes(keys.wardrobePk(wardrobeId), keys.itemSk(itemId), {
        render: previousRender ?? null,
        updatedAt: nowIso(),
      });
    } catch (compensateError) {
      logger.error('Failed to roll back item render after enqueue failure', {
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

  return toClothingItem(updated);
}

/**
 * WARDROBE-123 — re-enqueue PROCESS_WARDROBE_ITEM for a FAILED item.
 *
 * PENDING / PROCESSING are 409 (already in flight). There is no stuck-PENDING
 * timeout in the worker; do not invent one. READY is 409 ITEM_NOT_RETRIABLE.
 * Concurrent FAILED retries are idempotent via a Dynamo condition.
 */
async function reprocessItem(
  userId: string,
  wardrobeId: string,
  itemId: string,
): Promise<ClothingItem> {
  const item = await getOwnedItem(userId, wardrobeId, itemId);
  await assertPremiumAi(userId);

  const originalImageKey = itemOriginalKey(item);
  if (!originalImageKey) {
    throw Errors.validation('Item has no original image to reprocess.');
  }

  const status = (item.processingStatus as ProcessingStatus | undefined) ?? 'READY';
  if (status === 'PROCESSING') {
    throw Errors.processingInProgress('Item is already processing.');
  }
  if (status === 'PENDING') {
    throw Errors.processingInProgress('Item processing is already queued.');
  }
  if (status !== 'FAILED') {
    throw Errors.itemNotRetriable();
  }

  const previousError =
    typeof item.processingError === 'string' && item.processingError.trim()
      ? item.processingError
      : undefined;

  let reset: DynamoItem;
  try {
    reset = await updateAttributes(
      keys.wardrobePk(wardrobeId),
      keys.itemSk(itemId),
      {
        processingStatus: 'PENDING',
        updatedAt: nowIso(),
      },
      {
        remove: ['processingError'],
        conditionExpression:
          'attribute_exists(PK) AND #processingStatus = :expectedStatus',
        extraValues: { ':expectedStatus': 'FAILED' },
      },
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      return toClothingItem(await reprocessAfterLostRace(userId, wardrobeId, itemId));
    }
    throw error;
  }

  try {
    await enqueueProcessWardrobeItem({
      userId,
      wardrobeId,
      itemId,
      originalImageKey,
    });
  } catch (error) {
    try {
      await updateAttributes(
        keys.wardrobePk(wardrobeId),
        keys.itemSk(itemId),
        {
          processingStatus: 'FAILED',
          updatedAt: nowIso(),
          ...(previousError ? { processingError: previousError } : {}),
        },
      );
    } catch (compensateError) {
      logger.error('Failed to restore FAILED after reprocess enqueue failure', {
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

  return toClothingItem(reset);
}

async function reprocessAfterLostRace(
  userId: string,
  wardrobeId: string,
  itemId: string,
): Promise<DynamoItem> {
  const current = await getOwnedItem(userId, wardrobeId, itemId);
  const status =
    (current.processingStatus as ProcessingStatus | undefined) ?? 'READY';
  if (status === 'PENDING') {
    return current;
  }
  if (status === 'PROCESSING') {
    throw Errors.processingInProgress('Item is already processing.');
  }
  if (status === 'FAILED') {
    throw Errors.processingInProgress(
      'Item processing retry is already in progress.',
    );
  }
  throw Errors.itemNotRetriable();
}

function itemTransferAction(
  event: APIGatewayProxyEventV2,
): 'move' | 'copy' | undefined {
  const key = routeKey(event);
  const path = event.rawPath ?? '';
  if (
    key.includes('/items/{itemId}/move') ||
    /\/items\/[^/]+\/move\/?$/.test(path)
  ) {
    return 'move';
  }
  if (
    key.includes('/items/{itemId}/copy') ||
    /\/items\/[^/]+\/copy\/?$/.test(path)
  ) {
    return 'copy';
  }
  return undefined;
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
  // Wardrobe ownership before body validation so a foreign wardrobe is
  // 404 WARDROBE_NOT_FOUND, not 400 on imageKey prefix.
  await getOwnedWardrobe(userId, wardrobeId);
  const name = requireNonEmptyString(body.name, 'name');
  const category = requireCategory(body.category);
  const imageKey = requireOwnedImageKey(body.imageKey, userId);
  const subcategory = optionalNonEmptyString(body.subcategory, 'subcategory');
  const colours = optionalStringArray(body.colours, 'colours');
  const brand = optionalNonEmptyString(body.brand, 'brand');
  const acquiredAt = optionalIsoDate(body.acquiredAt, 'acquiredAt');

  return persistNewClothingItem({
    userId,
    wardrobeId,
    name,
    category,
    imageKey,
    subcategory,
    colours,
    brand,
    acquiredAt,
  });
}

async function updateItem(
  userId: string,
  wardrobeId: string,
  itemId: string,
  body: UpdateItemBody,
): Promise<ClothingItem> {
  const existing = await getOwnedItem(userId, wardrobeId, itemId);

  const updates: Record<string, unknown> = {};
  const remove: string[] = [];

  if (body.name !== undefined) {
    updates.name = requireNonEmptyString(body.name, 'name');
  }
  if (body.category !== undefined) {
    updates.category = requireCategory(body.category);
  }
  // WARDROBE-87: omitted → no change; null / blank / whitespace → REMOVE.
  if (body.subcategory !== undefined) {
    const raw =
      typeof body.subcategory === 'string'
        ? body.subcategory.trim()
        : body.subcategory;
    const subcategory = optionalNonEmptyString(raw, 'subcategory');
    if (subcategory === undefined) {
      remove.push('subcategory');
    } else {
      updates.subcategory = subcategory;
    }
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
  // WARDROBE-92: omitted → no change; null / blank / whitespace → REMOVE.
  if (body.acquiredAt !== undefined) {
    const raw =
      typeof body.acquiredAt === 'string'
        ? body.acquiredAt.trim()
        : body.acquiredAt;
    const acquiredAt = optionalIsoDate(raw, 'acquiredAt');
    if (acquiredAt === undefined) {
      remove.push('acquiredAt');
    } else {
      updates.acquiredAt = acquiredAt;
    }
  }

  let imageReplacement: ImageReplacementPlan | undefined;
  if (body.imageKey !== undefined) {
    const imageKey = requireOwnedImageKey(body.imageKey, userId);
    const currentOriginal = itemOriginalKey(existing);
    if (imageKey === currentOriginal) {
      if (Object.keys(updates).length === 0 && remove.length === 0) {
        return toClothingItem(existing);
      }
    } else {
      imageReplacement = await planImageReplacement(userId, existing, imageKey);
      Object.assign(updates, imageReplacement.updates);
      remove.push(...imageReplacement.remove);
    }
  }

  if (Object.keys(updates).length === 0 && remove.length === 0) {
    throw Errors.validation('At least one field is required.');
  }

  const updated = await updateAttributes(
    keys.wardrobePk(wardrobeId),
    keys.itemSk(itemId),
    { ...updates, updatedAt: nowIso() },
    remove.length > 0 ? { remove: uniqueStrings(remove) } : undefined,
  );

  if (imageReplacement) {
    if (imageReplacement.enqueue) {
      try {
        await enqueueProcessWardrobeItem(imageReplacement.enqueue);
      } catch (error) {
        await rollbackImageReplacement(existing, imageReplacement);
        throw error;
      }
    }
    await deleteStaleImageObjects(imageReplacement.staleKeys);
  }

  return toClothingItem(updated);
}

interface ImageReplacementPlan {
  updates: Record<string, unknown>;
  remove: string[];
  staleKeys: string[];
  enqueue?: {
    userId: string;
    wardrobeId: string;
    itemId: string;
    originalImageKey: string;
    mode: typeof PROCESS_WARDROBE_ITEM_BACKGROUND_REMOVAL_ONLY;
  };
}

/**
 * WARDROBE-153: replace the stored original photo, drop stale processed
 * cutout metadata, and optionally enqueue background-removal only.
 * Name / category / colours / brand / other `ai` fields / membership /
 * renders are left untouched.
 */
async function planImageReplacement(
  userId: string,
  existing: DynamoItem,
  imageKey: string,
): Promise<ImageReplacementPlan> {
  const enqueueBackgroundRemoval = await shouldEnqueueBackgroundRemovalOnly(
    userId,
  );
  const updates: Record<string, unknown> = {
    originalKey: imageKey,
    processingStatus: enqueueBackgroundRemoval ? 'PENDING' : 'READY',
  };
  const remove = ['processedKey', 'processingError'];
  const cleanedAi = aiWithoutProcessedImage(existing.ai);
  if (cleanedAi.removeAi) {
    remove.push('ai');
  } else if (cleanedAi.next) {
    updates.ai = cleanedAi.next;
  }

  return {
    updates,
    remove,
    staleKeys: staleImageKeys(existing, imageKey),
    ...(enqueueBackgroundRemoval
      ? {
          enqueue: {
            userId,
            wardrobeId: String(existing.wardrobeId),
            itemId: String(existing.itemId),
            originalImageKey: imageKey,
            mode: PROCESS_WARDROBE_ITEM_BACKGROUND_REMOVAL_ONLY,
          },
        }
      : {}),
  };
}

async function shouldEnqueueBackgroundRemovalOnly(
  userId: string,
): Promise<boolean> {
  // Same Premium gate as createItem; BR-only jobs are pointless when the
  // worker flag is off, so skip the queue entirely in that case.
  if (!isBackgroundRemovalEnabled()) {
    return false;
  }
  const entitlement = await resolveEntitlement(userId);
  return isPremium(entitlement);
}

function aiWithoutProcessedImage(ai: unknown): {
  next?: Record<string, unknown>;
  removeAi: boolean;
} {
  if (!ai || typeof ai !== 'object' || Array.isArray(ai)) {
    return { removeAi: false };
  }
  const next = { ...(ai as Record<string, unknown>) };
  delete next.processedImageKey;
  delete next.backgroundRemoved;
  if (Object.keys(next).length === 0) {
    return { removeAi: true };
  }
  return { next, removeAi: false };
}

function staleImageKeys(existing: DynamoItem, newKey: string): string[] {
  const keysToDelete = new Set<string>();
  const oldOriginal = itemOriginalKey(existing);
  if (oldOriginal && oldOriginal !== newKey) {
    keysToDelete.add(oldOriginal);
  }
  if (typeof existing.processedKey === 'string') {
    const oldProcessed = existing.processedKey.trim();
    if (oldProcessed && oldProcessed !== newKey) {
      keysToDelete.add(oldProcessed);
    }
  }
  return [...keysToDelete];
}

async function deleteStaleImageObjects(objectKeys: string[]): Promise<void> {
  await Promise.all(objectKeys.map((objectKey) => deleteObjectBestEffort(objectKey)));
}

async function rollbackImageReplacement(
  existing: DynamoItem,
  plan: ImageReplacementPlan,
): Promise<void> {
  const wardrobeId = String(existing.wardrobeId);
  const itemId = String(existing.itemId);
  try {
    const restore: Record<string, unknown> = {
      processingStatus:
        (existing.processingStatus as ProcessingStatus | undefined) ?? 'READY',
      updatedAt: nowIso(),
    };
    const remove: string[] = [];

    const previousOriginal = itemOriginalKey(existing);
    if (previousOriginal) {
      restore.originalKey = previousOriginal;
    } else {
      remove.push('originalKey');
    }

    if (typeof existing.processedKey === 'string' && existing.processedKey.trim()) {
      restore.processedKey = existing.processedKey;
    } else {
      remove.push('processedKey');
    }

    if (existing.ai && typeof existing.ai === 'object' && !Array.isArray(existing.ai)) {
      restore.ai = existing.ai;
    } else if (plan.updates.ai !== undefined || plan.remove.includes('ai')) {
      remove.push('ai');
    }

    if (
      typeof existing.processingError === 'string' &&
      existing.processingError.trim()
    ) {
      restore.processingError = existing.processingError;
    } else {
      remove.push('processingError');
    }

    await updateAttributes(
      keys.wardrobePk(wardrobeId),
      keys.itemSk(itemId),
      restore,
      remove.length > 0 ? { remove: uniqueStrings(remove) } : undefined,
    );
  } catch (compensateError) {
    logger.error('Failed to roll back item image after enqueue failure', {
      itemId,
      wardrobeId,
      error:
        compensateError instanceof Error
          ? compensateError.message
          : 'unknown',
    });
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

async function removeItem(
  userId: string,
  wardrobeId: string,
  itemId: string,
): Promise<void> {
  await getOwnedItem(userId, wardrobeId, itemId);
  await deleteItem(keys.wardrobePk(wardrobeId), keys.itemSk(itemId));
}

async function deleteItemRenderPhoto(
  userId: string,
  wardrobeId: string,
  itemId: string,
  body: DeleteRenderBody,
): Promise<void> {
  const imageKey = requireOwnedItemRenderKey(body.imageKey, userId, itemId);
  const item = await getOwnedItem(userId, wardrobeId, itemId);
  const plan = planRenderPhotoDelete(item, imageKey);
  if (plan) {
    await updateAttributes(
      keys.wardrobePk(wardrobeId),
      keys.itemSk(itemId),
      plan.updates,
      plan.remove.length > 0 ? { remove: plan.remove } : undefined,
    );
  }

  await deleteObjectBestEffort(imageKey);
}
