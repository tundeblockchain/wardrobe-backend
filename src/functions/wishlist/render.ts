import { getOwnedWish, keys, updateAttributes } from '../../shared/dynamodb';
import { assertPremiumAi } from '../../shared/entitlements';
import { Errors } from '../../shared/errors';
import { newOutfitRenderId, nowIso } from '../../shared/ids';
import { logger } from '../../shared/logger';
import {
  copyObject,
  deleteObjectBestEffort,
  deleteObjectsUnderPrefix,
  itemRenderPrefix,
  wishRenderPrefix,
} from '../../shared/s3';
import { enqueueRenderWish } from '../../shared/sqs';
import {
  DynamoItem,
  OutfitRender,
  OutfitRenderHistoryEntry,
  Wish,
} from '../../shared/types';
import { requireCategory, requireNonEmptyString } from '../../shared/validation';
import {
  pendingRender,
  planRenderPhotoDelete,
  requireReadyRenderableProfile,
  seedHistoryFromCurrentRender,
  toOutfitRender,
  toRenderHistory,
  withSignedRenderUrl,
} from '../outfits/render';
import { toWishDto, wishOriginalKey } from './model';

export interface RequestWishRenderBody {
  aiProfileId?: unknown;
  userId?: unknown;
}

export interface DeleteWishRenderBody {
  imageKey?: unknown;
  userId?: unknown;
}

export async function getWishRender(
  userId: string,
  wishId: string,
): Promise<OutfitRender> {
  const wish = await getOwnedWish(userId, wishId);
  const render = toOutfitRender(wish.render);
  if (!render) {
    throw Errors.renderNotFound();
  }
  return withSignedRenderUrl(render);
}

export async function requestWishRender(
  userId: string,
  wishId: string,
  body: RequestWishRenderBody,
): Promise<Wish> {
  const existing = await getOwnedWish(userId, wishId);
  await assertPremiumAi(userId);
  const previousRender = existing.render;
  const aiProfileId = requireNonEmptyString(body.aiProfileId, 'aiProfileId');
  await requireReadyRenderableProfile(userId, aiProfileId);

  if (!wishOriginalKey(existing)) {
    throw Errors.wishImageRequired();
  }
  if (typeof existing.category !== 'string' || !existing.category.trim()) {
    throw Errors.wishCategoryRequired();
  }
  requireCategory(existing.category);

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
    keys.userPk(userId),
    keys.wishSk(wishId),
    updates,
  );

  try {
    await enqueueRenderWish({
      userId,
      wishId,
      aiProfileId,
      renderId,
    });
  } catch (error) {
    try {
      await updateAttributes(keys.userPk(userId), keys.wishSk(wishId), {
        render: previousRender ?? null,
        updatedAt: nowIso(),
      });
    } catch (compensateError) {
      logger.error('Failed to roll back wish render after enqueue failure', {
        wishId,
        error:
          compensateError instanceof Error
            ? compensateError.message
            : 'unknown',
      });
    }
    throw error;
  }

  return toWishDto(updated);
}

export async function deleteWishRenderPhoto(
  userId: string,
  wishId: string,
  imageKey: string,
): Promise<void> {
  const wish = await getOwnedWish(userId, wishId);
  const plan = planRenderPhotoDelete(wish, imageKey);
  if (plan) {
    await updateAttributes(
      keys.userPk(userId),
      keys.wishSk(wishId),
      plan.updates,
      plan.remove.length > 0 ? { remove: plan.remove } : undefined,
    );
  }

  await deleteObjectBestEffort(imageKey);
}

export async function deleteWishRenderMedia(
  userId: string,
  wishId: string,
): Promise<void> {
  await deleteObjectsUnderPrefix(
    wishRenderPrefix(userId, wishId),
    'wish try-on wipe',
  );
}

/**
 * READY try-on photos on a wish, remapped onto a new clothing item
 * (WARDROBE-253 acquire). PENDING / PROCESSING / FAILED current status is
 * not copied — an in-flight wish job is dropped when the wish row is
 * deleted.
 */
export function wishRendersForItemAcquire(
  userId: string,
  wishId: string,
  itemId: string,
  wish: DynamoItem,
): {
  render?: Record<string, unknown>;
  renderHistory?: OutfitRenderHistoryEntry[];
  copies: Array<{ sourceKey: string; destinationKey: string }>;
} {
  const current = toOutfitRender(wish.render);
  const history = seedHistoryFromCurrentRender(
    toRenderHistory(wish.renderHistory),
    current,
    wish.updatedAt,
  );
  if (history.length === 0) {
    return { copies: [] };
  }

  const copies: Array<{ sourceKey: string; destinationKey: string }> = [];
  const remappedHistory: OutfitRenderHistoryEntry[] = [];
  for (const entry of history) {
    const destinationKey = remapWishRenderKey(
      userId,
      wishId,
      itemId,
      entry.imageKey,
    );
    copies.push({ sourceKey: entry.imageKey, destinationKey });
    remappedHistory.push({
      imageKey: destinationKey,
      createdAt: entry.createdAt,
      aiProfileId: entry.aiProfileId,
    });
  }

  const result: {
    render?: Record<string, unknown>;
    renderHistory?: OutfitRenderHistoryEntry[];
    copies: Array<{ sourceKey: string; destinationKey: string }>;
  } = {
    renderHistory: remappedHistory,
    copies,
  };

  if (current?.status === 'READY' && current.imageKey) {
    const destinationKey = remapWishRenderKey(
      userId,
      wishId,
      itemId,
      current.imageKey,
    );
    result.render = {
      status: 'READY',
      aiProfileId: current.aiProfileId,
      imageKey: destinationKey,
    };
  }

  return result;
}

export async function copyWishRenderObjects(
  copies: Array<{ sourceKey: string; destinationKey: string }>,
): Promise<string[]> {
  const copied: string[] = [];
  try {
    for (const { sourceKey, destinationKey } of copies) {
      await copyObject({ sourceKey, destinationKey });
      copied.push(destinationKey);
    }
  } catch (error) {
    for (const key of copied) {
      await deleteObjectBestEffort(key);
    }
    throw error;
  }
  return copied;
}

export function remapWishRenderKey(
  userId: string,
  wishId: string,
  itemId: string,
  imageKey: string,
): string {
  const prefix = wishRenderPrefix(userId, wishId);
  if (!imageKey.startsWith(prefix)) {
    return imageKey;
  }
  return `${itemRenderPrefix(userId, itemId)}${imageKey.slice(prefix.length)}`;
}
