import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import {
  getItem,
  getOwnedItem,
  getOwnedOutfit,
  keys,
  putItem,
  updateAttributes,
} from '../../shared/dynamodb';
import { Errors } from '../../shared/errors';
import {
  created,
  errorResponse,
  noContent,
  ok,
  routeKey,
} from '../../shared/http';
import { nowIso } from '../../shared/ids';
import { logger } from '../../shared/logger';
import { createPresignedGetUrl } from '../../shared/s3';
import { DynamoItem, Share, SharePreview } from '../../shared/types';
import {
  clothingPreviewImageKey,
  firstOutfitItemId,
  isOwnedShare,
  isShareGone,
  isShareItem,
  isShareToken,
  normalizeShareToken,
  outfitRenderPreviewKey,
  toShareDto,
  toShareItem,
  toSharePreviewDto,
} from './model';

/**
 * Share-link API (WARDROBE-126).
 *
 * Authenticated (Firebase authorizer, owner only):
 *   POST /wardrobes/{wardrobeId}/items/{itemId}/share
 *   POST /wardrobes/{wardrobeId}/outfits/{outfitId}/share
 *   DELETE /shares/{token}
 *
 * Public (no authorizer):
 *   GET /public/shares/{token}
 *
 * Growth feature — not entitlement-gated. Creating again issues a new token;
 * previous tokens stay valid until expiry or revoke.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    const method = event.requestContext.http.method;

    if (isPublicPreviewRoute(event)) {
      if (method !== 'GET') {
        throw Errors.validation(`Unsupported method: ${method}`);
      }
      return ok(await getPublicPreview(requireToken(event)));
    }

    const userId = getUserId(event);

    if (isRevokeRoute(event)) {
      if (method !== 'DELETE') {
        throw Errors.validation(`Unsupported method: ${method}`);
      }
      await revokeShare(userId, event.pathParameters?.token);
      return noContent();
    }

    const wardrobeId = event.pathParameters?.wardrobeId?.trim();
    if (!wardrobeId) {
      throw Errors.validation('wardrobeId is required.');
    }

    if (isItemShareRoute(event)) {
      if (method !== 'POST') {
        throw Errors.validation(`Unsupported method: ${method}`);
      }
      const itemId = event.pathParameters?.itemId?.trim();
      if (!itemId) {
        throw Errors.validation('itemId is required.');
      }
      return created(await createItemShare(userId, wardrobeId, itemId));
    }

    if (isOutfitShareRoute(event)) {
      if (method !== 'POST') {
        throw Errors.validation(`Unsupported method: ${method}`);
      }
      const outfitId = event.pathParameters?.outfitId?.trim();
      if (!outfitId) {
        throw Errors.validation('outfitId is required.');
      }
      return created(await createOutfitShare(userId, wardrobeId, outfitId));
    }

    throw Errors.validation(`Unsupported route: ${routeKey(event)}`);
  } catch (error) {
    return errorResponse(error);
  }
}

function isPublicPreviewRoute(event: APIGatewayProxyEventV2): boolean {
  const key = routeKey(event);
  const path = event.rawPath ?? '';
  return (
    key.includes('/public/shares/{token}') ||
    key.includes('/public/shares/') ||
    /\/public\/shares\/[^/]+\/?$/.test(path)
  );
}

function isRevokeRoute(event: APIGatewayProxyEventV2): boolean {
  if (isPublicPreviewRoute(event)) {
    return false;
  }
  const key = routeKey(event);
  const path = event.rawPath ?? '';
  return (
    key.includes('DELETE /shares/{token}') ||
    /^DELETE \/shares\/\{token\}$/.test(key) ||
    key === 'DELETE /shares/{token}' ||
    /\/shares\/[^/]+\/?$/.test(path)
  );
}

function isItemShareRoute(event: APIGatewayProxyEventV2): boolean {
  const key = routeKey(event);
  const path = event.rawPath ?? '';
  return (
    key.includes('/items/{itemId}/share') ||
    (key.includes('/share') && key.includes('/items/')) ||
    /\/items\/[^/]+\/share\/?$/.test(path)
  );
}

function isOutfitShareRoute(event: APIGatewayProxyEventV2): boolean {
  const key = routeKey(event);
  const path = event.rawPath ?? '';
  return (
    key.includes('/outfits/{outfitId}/share') ||
    (key.includes('/share') && key.includes('/outfits/')) ||
    /\/outfits\/[^/]+\/share\/?$/.test(path)
  );
}

function requireToken(event: APIGatewayProxyEventV2): string {
  const raw = event.pathParameters?.token?.trim() ?? '';
  if (!isShareToken(raw)) {
    throw Errors.shareNotFound();
  }
  return normalizeShareToken(raw);
}

async function createItemShare(
  userId: string,
  wardrobeId: string,
  itemId: string,
): Promise<Share> {
  await getOwnedItem(userId, wardrobeId, itemId);
  const item = toShareItem({
    userId,
    wardrobeId,
    resourceType: 'ITEM',
    itemId,
  });
  await putItem(item);
  return toShareDto(item);
}

async function createOutfitShare(
  userId: string,
  wardrobeId: string,
  outfitId: string,
): Promise<Share> {
  await getOwnedOutfit(userId, wardrobeId, outfitId);
  const item = toShareItem({
    userId,
    wardrobeId,
    resourceType: 'OUTFIT',
    outfitId,
  });
  await putItem(item);
  return toShareDto(item);
}

/**
 * Idempotent for missing / already-revoked / expired tokens.
 * Another user's token is 404 SHARE_NOT_FOUND (same as other owner-only routes).
 */
async function revokeShare(
  userId: string,
  rawToken: string | undefined,
): Promise<void> {
  const token = rawToken?.trim() ?? '';
  if (!isShareToken(token)) {
    return;
  }

  const existing = await getItem(keys.sharePk(token), keys.shareSk);
  if (!existing || !isShareItem(existing)) {
    return;
  }
  if (!isOwnedShare(existing, userId)) {
    throw Errors.shareNotFound();
  }
  if (isShareGone(existing)) {
    return;
  }

  await updateAttributes(keys.sharePk(token), keys.shareSk, {
    revokedAt: nowIso(),
    updatedAt: nowIso(),
  });
}

async function getPublicPreview(token: string): Promise<SharePreview> {
  const share = await getItem(keys.sharePk(token), keys.shareSk);
  if (!share || !isShareItem(share)) {
    throw Errors.shareNotFound();
  }
  if (isShareGone(share)) {
    throw Errors.shareGone();
  }

  if (share.resourceType === 'ITEM') {
    return previewItem(share);
  }
  return previewOutfit(share);
}

async function previewItem(share: DynamoItem): Promise<SharePreview> {
  const wardrobeId = String(share.wardrobeId ?? '');
  const itemId = String(share.itemId ?? '');
  const item = await getItem(keys.wardrobePk(wardrobeId), keys.itemSk(itemId));
  if (
    !item ||
    item.entityType !== 'ITEM' ||
    item.userId !== share.userId ||
    item.wardrobeId !== wardrobeId
  ) {
    throw Errors.shareGone();
  }

  const title =
    typeof item.name === 'string' && item.name.trim()
      ? item.name.trim()
      : 'Item';
  const imageUrl = await signedPreviewUrl(clothingPreviewImageKey(item));
  return toSharePreviewDto(share, title, imageUrl);
}

async function previewOutfit(share: DynamoItem): Promise<SharePreview> {
  const wardrobeId = String(share.wardrobeId ?? '');
  const outfitId = String(share.outfitId ?? '');
  const outfit = await getItem(
    keys.wardrobePk(wardrobeId),
    keys.outfitSk(outfitId),
  );
  if (
    !outfit ||
    outfit.entityType !== 'OUTFIT' ||
    outfit.userId !== share.userId ||
    outfit.wardrobeId !== wardrobeId
  ) {
    throw Errors.shareGone();
  }

  const title =
    typeof outfit.name === 'string' && outfit.name.trim()
      ? outfit.name.trim()
      : 'Outfit';

  let imageKey = outfitRenderPreviewKey(outfit);
  if (!imageKey) {
    const firstItemId = firstOutfitItemId(outfit);
    if (firstItemId) {
      const garment = await getItem(
        keys.wardrobePk(wardrobeId),
        keys.itemSk(firstItemId),
      );
      if (
        garment &&
        garment.entityType === 'ITEM' &&
        garment.userId === share.userId
      ) {
        imageKey = clothingPreviewImageKey(garment);
      }
    }
  }

  const imageUrl = await signedPreviewUrl(imageKey);
  return toSharePreviewDto(share, title, imageUrl);
}

async function signedPreviewUrl(
  objectKey: string | undefined,
): Promise<string | undefined> {
  if (!objectKey) {
    return undefined;
  }
  try {
    const { imageUrl } = await createPresignedGetUrl({ objectKey });
    return imageUrl;
  } catch (error) {
    logger.warn('Failed to presign share preview image GET URL', {
      objectKey,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return undefined;
  }
}
