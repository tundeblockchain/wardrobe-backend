import { logger } from '../../shared/logger';
import { createPresignedGetUrl } from '../../shared/s3';
import {
  ClothingCategory,
  ClothingItem,
  DynamoItem,
  ProcessingStatus,
} from '../../shared/types';
import {
  seedHistoryFromCurrentRender,
  toOutfitRender,
  toRenderHistory,
  withSignedRenderHistory,
  withSignedRenderUrl,
} from '../outfits/render';

export function itemOriginalKey(item: DynamoItem): string | undefined {
  if (typeof item.originalKey !== 'string') {
    return undefined;
  }
  const trimmed = item.originalKey.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function storedRenderHistory(item: DynamoItem) {
  return seedHistoryFromCurrentRender(
    toRenderHistory(item.renderHistory),
    toOutfitRender(item.render),
    item.updatedAt,
  );
}

export async function toClothingItem(item: DynamoItem): Promise<ClothingItem> {
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
  if (typeof item.acquiredAt === 'string' && item.acquiredAt.trim()) {
    dto.acquiredAt = item.acquiredAt;
  }
  if (
    dto.processingStatus === 'FAILED' &&
    typeof item.processingError === 'string' &&
    item.processingError.trim()
  ) {
    dto.processingError = item.processingError;
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

  const render = toOutfitRender(item.render);
  const signedHistory = await withSignedRenderHistory(storedRenderHistory(item));
  if (render) {
    dto.render = await withSignedRenderUrl(render);
  }
  if (signedHistory.renderHistory) {
    dto.renderHistory = signedHistory.renderHistory;
  }
  if (signedHistory.renderImageUrls) {
    dto.renderImageUrls = signedHistory.renderImageUrls;
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
