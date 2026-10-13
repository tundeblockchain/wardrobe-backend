import { keys, queryByPk } from '../../shared/dynamodb';
import { logger } from '../../shared/logger';
import { createPresignedGetUrl } from '../../shared/s3';
import { DynamoItem } from '../../shared/types';

/**
 * Optional stored cover key on the wardrobe row itself (WARDROBE-178).
 * Create / PATCH do not write these today; if a row already has one, list
 * uses it instead of scanning items.
 *
 * Precedence: `coverImageKey`, `imageKey`, then processed, then original
 * (including a nested `image` map).
 */
export function wardrobeOwnImageKey(item: DynamoItem): string | undefined {
  const nested =
    item.image && typeof item.image === 'object' && !Array.isArray(item.image)
      ? (item.image as Record<string, unknown>)
      : undefined;

  return firstNonEmptyKey(
    item.coverImageKey,
    item.imageKey,
    item.processedKey,
    nested?.processedKey,
    item.originalKey,
    nested?.originalKey,
  );
}

/** Display photo: processed cutout, then original. Never a try-on render. */
export function clothingCoverImageKey(item: DynamoItem): string | undefined {
  return firstNonEmptyKey(item.processedKey, item.originalKey);
}

/**
 * "First item" is earliest `createdAt`, then `itemId` (both ascending).
 * Walks that order and uses the first clothing item that has a photo so an
 * imageless oldest row does not hide a later cover.
 */
export function firstItemCoverImageKey(
  items: DynamoItem[],
  userId: string,
  wardrobeId: string,
): string | undefined {
  const clothing = items
    .filter(
      (item) =>
        item.entityType === 'ITEM' &&
        item.userId === userId &&
        item.wardrobeId === wardrobeId,
    )
    .sort(compareItemsByCreatedAtThenId);

  for (const item of clothing) {
    const objectKey = clothingCoverImageKey(item);
    if (objectKey) {
      return objectKey;
    }
  }
  return undefined;
}

export async function resolveCoverObjectKeys(
  userId: string,
  wardrobes: DynamoItem[],
): Promise<Array<string | undefined>> {
  const ownKeys = wardrobes.map(wardrobeOwnImageKey);
  const fallbackIds = wardrobes
    .map((item, index) => ({
      index,
      wardrobeId: String(item.wardrobeId ?? ''),
    }))
    .filter(
      ({ index, wardrobeId }) =>
        !ownKeys[index] && wardrobeId.length > 0,
    );

  const itemsByWardrobe = new Map<string, DynamoItem[]>();
  const uniqueFallbackIds = [...new Set(fallbackIds.map((row) => row.wardrobeId))];
  await Promise.all(
    uniqueFallbackIds.map(async (wardrobeId) => {
      itemsByWardrobe.set(
        wardrobeId,
        await queryByPk(keys.wardrobePk(wardrobeId), 'ITEM#'),
      );
    }),
  );

  return wardrobes.map((item, index) => {
    if (ownKeys[index]) {
      return ownKeys[index];
    }
    const wardrobeId = String(item.wardrobeId ?? '');
    return firstItemCoverImageKey(
      itemsByWardrobe.get(wardrobeId) ?? [],
      userId,
      wardrobeId,
    );
  });
}

export async function signedCoverImageUrl(
  objectKey: string,
): Promise<string | undefined> {
  if (!objectKey.trim()) {
    return undefined;
  }

  try {
    const { imageUrl } = await createPresignedGetUrl({ objectKey });
    return imageUrl;
  } catch (error) {
    logger.warn('Failed to presign wardrobe cover image GET URL', {
      objectKey,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return undefined;
  }
}

export async function signCoverImageUrls(
  objectKeys: Array<string | undefined>,
): Promise<Array<string | undefined>> {
  const unique = [
    ...new Set(
      objectKeys.filter((key): key is string => Boolean(key && key.trim())),
    ),
  ];
  const signed = new Map<string, string>();
  await Promise.all(
    unique.map(async (objectKey) => {
      const imageUrl = await signedCoverImageUrl(objectKey);
      if (imageUrl) {
        signed.set(objectKey, imageUrl);
      }
    }),
  );
  return objectKeys.map((key) => (key ? signed.get(key) : undefined));
}

function compareItemsByCreatedAtThenId(a: DynamoItem, b: DynamoItem): number {
  const createdA = String(a.createdAt ?? '');
  const createdB = String(b.createdAt ?? '');
  if (createdA !== createdB) {
    return createdA < createdB ? -1 : 1;
  }
  const idA = String(a.itemId ?? '');
  const idB = String(b.itemId ?? '');
  if (idA === idB) {
    return 0;
  }
  return idA < idB ? -1 : 1;
}

function firstNonEmptyKey(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
