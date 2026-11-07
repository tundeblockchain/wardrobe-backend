import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import {
  deleteItem,
  getOwnedWish,
  isTransactionCanceled,
  keys,
  listOwnedWishes,
  putItem,
  transactWrite,
  updateAttributes,
} from '../../shared/dynamodb';
import { Errors } from '../../shared/errors';
import {
  accepted,
  created,
  errorResponse,
  noContent,
  ok,
  parseJsonBody,
  requirePathParam,
  routeKey,
} from '../../shared/http';
import { newItemId, newUploadId, newWishId, nowIso } from '../../shared/ids';
import { logger } from '../../shared/logger';
import {
  assertUploadContentLength,
  copyObject,
  createPresignedPutUrl,
  deleteObjectBestEffort,
  extensionForContentType,
  extensionFromObjectKey,
  itemOriginalObjectKey,
  normalizeContentType,
  wishlistMediaPrefix,
} from '../../shared/s3';
import {
  ClothingCategory,
  ClothingSubcategory,
  DynamoItem,
  Wish,
  WishList,
  WISH_NOTES_MAX,
  WISHLIST_MAX_ITEMS,
  WISH_NAME_MAX,
} from '../../shared/types';
import {
  optionalCategory,
  optionalHttpsUrl,
  optionalInteger,
  optionalNonEmptyString,
  optionalQueryString,
  optionalSubcategory,
  optionalWishPrice,
  requireCategory,
  requireNonEmptyString,
  requireOwnedImageKey,
  requireOwnedWishRenderKey,
} from '../../shared/validation';
import {
  buildNewClothingItem,
  enqueueCreateItemProcessing,
  prepareNewClothingItem,
} from '../items/create';
import { toClothingItem } from '../items/dto';
import {
  compareWishesNewestFirst,
  decodeWishCursor,
  encodeWishCursor,
  isAfterWishCursor,
  parseWishListLimit,
  toWishDto,
  wishOriginalKey,
} from './model';
import {
  copyWishRenderObjects,
  deleteWishRenderMedia,
  deleteWishRenderPhoto,
  getWishRender,
  requestWishRender,
  wishRendersForItemAcquire,
} from './render';

interface CreateWishBody {
  name?: unknown;
  category?: unknown;
  subcategory?: unknown;
  imageKey?: unknown;
  link?: unknown;
  price?: unknown;
  notes?: unknown;
  userId?: unknown;
}

interface UpdateWishBody extends CreateWishBody {}

interface CreateWishUploadBody {
  contentType?: unknown;
  contentLength?: unknown;
  purpose?: unknown;
  userId?: unknown;
}

interface AcquireWishBody {
  wardrobeId?: unknown;
  userId?: unknown;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = getUserId(event);
    const method = event.requestContext.http.method;
    const key = routeKey(event);
    const path = event.rawPath ?? '';

    if (isUploadsRoute(key, path)) {
      if (method !== 'POST') {
        throw Errors.validation(`Unsupported method: ${method}`);
      }
      return created(await createWishUploadUrl(userId, parseJsonBody(event)));
    }

    if (isAcquireRoute(key, path)) {
      if (method !== 'POST') {
        throw Errors.validation(`Unsupported method: ${method}`);
      }
      const wishId = requirePathParam(event, 'wishId');
      return created(
        await acquireWish(userId, wishId, parseJsonBody<AcquireWishBody>(event)),
      );
    }

    if (isWishRendersRoute(key, path)) {
      if (method !== 'DELETE') {
        throw Errors.validation(`Unsupported method: ${method}`);
      }
      const wishId = requirePathParam(event, 'wishId');
      const body = parseJsonBody<{ imageKey?: unknown }>(event);
      await deleteWishRenderPhoto(
        userId,
        wishId,
        requireOwnedWishRenderKey(body.imageKey, userId, wishId),
      );
      return noContent();
    }

    if (isWishRenderRoute(key, path)) {
      const wishId = requirePathParam(event, 'wishId');
      if (method === 'GET') {
        return ok(await getWishRender(userId, wishId));
      }
      if (method === 'POST') {
        return accepted(
          await requestWishRender(userId, wishId, parseJsonBody(event)),
        );
      }
      throw Errors.validation(`Unsupported method: ${method}`);
    }

    const wishId = event.pathParameters?.wishId?.trim();

    if (!wishId) {
      if (method === 'GET') {
        return ok(await listWishes(userId, event.queryStringParameters));
      }
      if (method === 'POST') {
        return created(await createWish(userId, parseJsonBody(event)));
      }
      throw Errors.validation(`Unsupported method: ${method}`);
    }

    if (method === 'GET') {
      return ok(await toWishDto(await getOwnedWish(userId, wishId)));
    }
    if (method === 'PATCH') {
      return ok(await updateWish(userId, wishId, parseJsonBody(event)));
    }
    if (method === 'DELETE') {
      await removeWish(userId, wishId);
      return noContent();
    }

    throw Errors.validation(`Unsupported method: ${method}`);
  } catch (error) {
    return errorResponse(error);
  }
}

function isUploadsRoute(key: string, path: string): boolean {
  return (
    key.includes('/wishlist/uploads') || /\/wishlist\/uploads\/?$/.test(path)
  );
}

function isAcquireRoute(key: string, path: string): boolean {
  return (
    key.includes('/wishlist/{wishId}/acquire') ||
    /\/wishlist\/[^/]+\/acquire\/?$/.test(path)
  );
}

function isWishRendersRoute(key: string, path: string): boolean {
  return (
    key.includes('/wishlist/{wishId}/renders') ||
    /\/wishlist\/[^/]+\/renders\/?$/.test(path)
  );
}

/**
 * Current poll + generate. Do not match WARDROBE-253
 * `DELETE .../wishlist/{wishId}/renders` (plural).
 */
function isWishRenderRoute(key: string, path: string): boolean {
  return (
    (key.includes('/wishlist/{wishId}/render') &&
      !key.includes('/wishlist/{wishId}/renders')) ||
    /\/wishlist\/[^/]+\/render\/?$/.test(path)
  );
}

async function createWishUploadUrl(userId: string, body: CreateWishUploadBody) {
  const contentType = normalizeContentType(
    requireNonEmptyString(body.contentType, 'contentType', 64),
  );
  if (body.purpose !== undefined && body.purpose !== null && body.purpose !== '') {
    const purpose = requireNonEmptyString(body.purpose, 'purpose', 64);
    if (purpose !== 'WISHLIST') {
      throw Errors.uploadInvalid('purpose must be WISHLIST.');
    }
  }

  const declaredLength = optionalInteger(body.contentLength, 'contentLength');
  const contentLength =
    declaredLength === undefined
      ? undefined
      : assertUploadContentLength(declaredLength);

  const extension = extensionForContentType(contentType);
  const objectKey = `${wishlistMediaPrefix(userId)}uploads/${newUploadId()}.${extension}`;
  const { uploadUrl, expiresIn } = await createPresignedPutUrl({
    objectKey,
    contentType,
    contentLength,
  });

  return {
    uploadUrl,
    objectKey,
    expiresIn,
  };
}

async function listWishes(
  userId: string,
  query: APIGatewayProxyEventV2['queryStringParameters'],
): Promise<WishList> {
  const limit = parseWishListLimit(optionalQueryString(query?.limit, 'limit'));
  const category = optionalCategory(query?.category);
  const cursorRaw =
    query?.cursor === undefined || query?.cursor === null || query?.cursor === ''
      ? undefined
      : requireNonEmptyString(query.cursor, 'cursor', 512);
  const cursor = cursorRaw ? decodeWishCursor(cursorRaw) : undefined;

  const rows = (await listOwnedWishes(userId))
    .filter((item) => (category ? item.category === category : true))
    .sort(compareWishesNewestFirst);

  const afterCursor = cursor
    ? rows.filter((item) => isAfterWishCursor(item, cursor))
    : rows;
  const page = afterCursor.slice(0, limit);
  const list: WishList = {
    wishes: await Promise.all(page.map(toWishDto)),
  };
  if (afterCursor.length > limit && page.length > 0) {
    const last = page[page.length - 1];
    list.nextCursor = encodeWishCursor({
      createdAt: String(last.createdAt),
      wishId: String(last.wishId),
    });
  }
  return list;
}

async function createWish(
  userId: string,
  body: CreateWishBody,
): Promise<Wish> {
  const existing = await listOwnedWishes(userId);
  if (existing.length >= WISHLIST_MAX_ITEMS) {
    throw Errors.wishlistLimit();
  }

  const fields = parseWishFields(body, userId, { requiredName: true });
  const wishId = newWishId();
  const timestamp = nowIso();
  const item: DynamoItem = {
    PK: keys.userPk(userId),
    SK: keys.wishSk(wishId),
    entityType: 'WISH',
    userId,
    wishId,
    name: fields.name!,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  assignWishAttributes(item, fields);

  await putItem(item);
  return toWishDto(item);
}

async function updateWish(
  userId: string,
  wishId: string,
  body: UpdateWishBody,
): Promise<Wish> {
  const existing = await getOwnedWish(userId, wishId);
  const updates: Record<string, unknown> = {};
  const remove: string[] = [];
  let staleImageKey: string | undefined;

  if (body.name !== undefined) {
    updates.name = requireNonEmptyString(body.name, 'name', WISH_NAME_MAX);
  }

  applyClearableUpdate(body.category, 'category', optionalCategory, updates, remove);
  applyClearableUpdate(
    body.subcategory,
    'subcategory',
    optionalSubcategory,
    updates,
    remove,
  );
  applyClearableUpdate(
    body.link,
    'link',
    (value) => optionalHttpsUrl(value, 'link'),
    updates,
    remove,
  );
  applyClearableUpdate(
    body.notes,
    'notes',
    (value) => optionalNonEmptyString(value, 'notes', WISH_NOTES_MAX),
    updates,
    remove,
  );

  if (body.price !== undefined) {
    const price = optionalWishPrice(body.price);
    if (price === undefined) {
      remove.push('price');
    } else {
      updates.price = price;
    }
  }

  if (body.imageKey !== undefined) {
    const raw =
      typeof body.imageKey === 'string' ? body.imageKey.trim() : body.imageKey;
    if (raw === undefined || raw === null || raw === '') {
      const current = wishOriginalKey(existing);
      if (current) {
        staleImageKey = current;
      }
      remove.push('originalKey');
    } else {
      const imageKey = requireOwnedImageKey(raw, userId);
      const current = wishOriginalKey(existing);
      if (imageKey !== current) {
        updates.originalKey = imageKey;
        if (current) {
          staleImageKey = current;
        }
      }
    }
  }

  if (Object.keys(updates).length === 0 && remove.length === 0) {
    throw Errors.validation('At least one field is required.');
  }

  const updated = await updateAttributes(
    keys.userPk(userId),
    keys.wishSk(wishId),
    { ...updates, updatedAt: nowIso() },
    remove.length > 0 ? { remove } : undefined,
  );

  if (staleImageKey) {
    await deleteObjectBestEffort(staleImageKey);
  }

  return toWishDto(updated);
}

async function removeWish(userId: string, wishId: string): Promise<void> {
  const existing = await getOwnedWish(userId, wishId);
  await deleteItem(keys.userPk(userId), keys.wishSk(wishId));
  const originalKey = wishOriginalKey(existing);
  if (originalKey) {
    await deleteObjectBestEffort(originalKey);
  }
  await deleteWishRenderMedia(userId, wishId);
}

/**
 * Move a wish into a wardrobe as a real clothing item.
 *
 * Item create has no stored usage counter (Free cap is a pre-read of ITEM
 * rows via `assertCanCreateCatalog`) — there is nothing extra to include
 * in the transaction.
 *
 * Order chosen so a failure never leaves both copies or neither:
 * 1. Cap / ownership checks (nothing written).
 * 2. Copy the wish image to the item original key.
 * 3. Copy READY try-on S3 objects onto the item render prefix (WARDROBE-253).
 * 4. One TransactWriteItems: put ITEM (including remapped render fields)
 *    + delete WISH (wish must still exist).
 * 5. On transact failure, delete copied original + render objects;
 *    Dynamo writes nothing.
 * 6. Enqueue Premium processing; on failure reverse with one transact
 *    (delete ITEM + put WISH) and drop the copied objects.
 * 7. Best-effort delete the wish image and wish try-on prefix (item copy
 *    remains).
 *
 * PENDING / PROCESSING / FAILED current try-on status is not copied.
 * An in-flight RENDER_WISH job is dropped when the wish row is deleted.
 */
async function acquireWish(
  userId: string,
  wishId: string,
  body: AcquireWishBody,
) {
  const wardrobeId = requireNonEmptyString(body.wardrobeId, 'wardrobeId');
  const wish = await getOwnedWish(userId, wishId);

  const name = typeof wish.name === 'string' ? wish.name.trim() : '';
  if (!name) {
    throw Errors.validation('Wish is missing a name.');
  }
  if (typeof wish.category !== 'string' || !wish.category.trim()) {
    throw Errors.validation('Wish must have a category before it can be acquired.');
  }
  const category = requireCategory(wish.category);
  const originalKey = wishOriginalKey(wish);
  if (!originalKey) {
    throw Errors.validation('Wish must have an image before it can be acquired.');
  }

  const { enqueueAi } = await prepareNewClothingItem(userId, wardrobeId);

  const itemId = newItemId();
  const destinationKey = itemOriginalObjectKey(
    userId,
    itemId,
    extensionFromObjectKey(originalKey),
  );
  const wishRenders = wishRendersForItemAcquire(userId, wishId, itemId, wish);
  const copiedKeys: string[] = [destinationKey];

  try {
    await copyObject({ sourceKey: originalKey, destinationKey });
  } catch (error) {
    logger.error('Failed to copy wish image for acquire', {
      wishId,
      itemId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    throw Errors.internal('Wish image could not be copied.');
  }

  try {
    const copiedRenders = await copyWishRenderObjects(wishRenders.copies);
    copiedKeys.push(...copiedRenders);
  } catch (error) {
    await deleteObjectBestEffort(destinationKey);
    logger.error('Failed to copy wish try-on photos for acquire', {
      wishId,
      itemId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    throw Errors.internal('Wish try-on photos could not be copied.');
  }

  const subcategory =
    typeof wish.subcategory === 'string' && wish.subcategory.trim()
      ? optionalSubcategory(wish.subcategory)
      : undefined;

  const item = buildNewClothingItem(
    {
      userId,
      wardrobeId,
      name,
      category,
      imageKey: destinationKey,
      subcategory,
      itemId,
    },
    enqueueAi,
  );
  if (wishRenders.render) {
    item.render = wishRenders.render;
  }
  if (wishRenders.renderHistory) {
    item.renderHistory = wishRenders.renderHistory;
  }

  try {
    await transactWrite(acquireItemAndDeleteWishOps(item, userId, wishId));
  } catch (error) {
    await Promise.all(copiedKeys.map((key) => deleteObjectBestEffort(key)));
    if (isTransactionCanceled(error)) {
      throw Errors.wishNotFound();
    }
    throw error;
  }

  if (enqueueAi) {
    try {
      await enqueueCreateItemProcessing(item);
    } catch (error) {
      try {
        await transactWrite(restoreWishAndDeleteItemOps(item, wish));
      } catch (compensateError) {
        logger.error('Failed to restore wish after acquire enqueue failure', {
          wishId,
          itemId,
          error:
            compensateError instanceof Error
              ? compensateError.message
              : 'unknown',
        });
      }
      await Promise.all(copiedKeys.map((key) => deleteObjectBestEffort(key)));
      throw error;
    }
  }

  if (originalKey !== destinationKey) {
    await deleteObjectBestEffort(originalKey);
  }
  await deleteWishRenderMedia(userId, wishId);

  return toClothingItem(item);
}

function acquireItemAndDeleteWishOps(
  item: DynamoItem,
  userId: string,
  wishId: string,
) {
  return [
    {
      put: {
        item,
        conditionExpression: 'attribute_not_exists(PK)',
      },
    },
    {
      delete: {
        pk: keys.userPk(userId),
        sk: keys.wishSk(wishId),
        conditionExpression: 'attribute_exists(PK)',
      },
    },
  ];
}

function restoreWishAndDeleteItemOps(item: DynamoItem, wish: DynamoItem) {
  return [
    {
      delete: {
        pk: keys.wardrobePk(String(item.wardrobeId)),
        sk: keys.itemSk(String(item.itemId)),
        conditionExpression: 'attribute_exists(PK)',
      },
    },
    {
      put: {
        item: wish,
        conditionExpression: 'attribute_not_exists(PK)',
      },
    },
  ];
}

interface ParsedWishFields {
  name?: string;
  category?: ClothingCategory;
  subcategory?: ClothingSubcategory;
  originalKey?: string;
  link?: string;
  price?: ReturnType<typeof optionalWishPrice>;
  notes?: string;
}

function parseWishFields(
  body: CreateWishBody,
  userId: string,
  options: { requiredName: boolean },
): ParsedWishFields {
  const fields: ParsedWishFields = {};
  if (options.requiredName) {
    fields.name = requireNonEmptyString(body.name, 'name', WISH_NAME_MAX);
  } else if (body.name !== undefined) {
    fields.name = requireNonEmptyString(body.name, 'name', WISH_NAME_MAX);
  }
  const category = optionalCategory(body.category);
  if (category) {
    fields.category = category;
  }
  const subcategory = optionalSubcategory(body.subcategory);
  if (subcategory) {
    fields.subcategory = subcategory;
  }
  if (body.imageKey !== undefined && body.imageKey !== null && body.imageKey !== '') {
    fields.originalKey = requireOwnedImageKey(body.imageKey, userId);
  }
  const link = optionalHttpsUrl(body.link, 'link');
  if (link) {
    fields.link = link;
  }
  const price = optionalWishPrice(body.price);
  if (price) {
    fields.price = price;
  }
  const notes = optionalNonEmptyString(body.notes, 'notes', WISH_NOTES_MAX);
  if (notes) {
    fields.notes = notes;
  }
  return fields;
}

function assignWishAttributes(
  item: DynamoItem,
  fields: ParsedWishFields,
): void {
  if (fields.category) {
    item.category = fields.category;
  }
  if (fields.subcategory) {
    item.subcategory = fields.subcategory;
  }
  if (fields.originalKey) {
    item.originalKey = fields.originalKey;
  }
  if (fields.link) {
    item.link = fields.link;
  }
  if (fields.price) {
    item.price = fields.price;
  }
  if (fields.notes) {
    item.notes = fields.notes;
  }
}

function applyClearableUpdate(
  value: unknown,
  field: string,
  parse: (value: unknown) => unknown,
  updates: Record<string, unknown>,
  remove: string[],
): void {
  if (value === undefined) {
    return;
  }
  if (value === null || value === '') {
    remove.push(field);
    return;
  }
  const parsed = parse(value);
  if (parsed === undefined) {
    remove.push(field);
    return;
  }
  updates[field] = parsed;
}
