import { Errors } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { createPresignedGetUrl } from '../../shared/s3';
import {
  ClothingCategory,
  ClothingSubcategory,
  DEFAULT_WISH_LIST_LIMIT,
  DynamoItem,
  MAX_WISH_LIST_LIMIT,
  Wish,
  WishPrice,
} from '../../shared/types';

export function isOwnedWish(
  item: DynamoItem | undefined,
  userId: string,
): item is DynamoItem {
  return !!item && item.entityType === 'WISH' && item.userId === userId;
}

export function wishOriginalKey(item: DynamoItem): string | undefined {
  if (typeof item.originalKey !== 'string') {
    return undefined;
  }
  const trimmed = item.originalKey.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function toWishDto(item: DynamoItem): Promise<Wish> {
  const dto: Wish = {
    wishId: String(item.wishId),
    name: String(item.name),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };

  if (typeof item.category === 'string' && item.category.trim()) {
    dto.category = item.category as ClothingCategory;
  }
  if (typeof item.subcategory === 'string' && item.subcategory.trim()) {
    dto.subcategory = item.subcategory as ClothingSubcategory;
  }
  const originalKey = wishOriginalKey(item);
  if (originalKey) {
    dto.image = { originalKey };
    const originalImageUrl = await signedWishImageUrl(originalKey);
    if (originalImageUrl) {
      dto.originalImageUrl = originalImageUrl;
    }
  }
  if (typeof item.link === 'string' && item.link.trim()) {
    dto.link = item.link;
  }
  const price = storedWishPrice(item.price);
  if (price) {
    dto.price = price;
  }
  if (typeof item.notes === 'string' && item.notes.trim()) {
    dto.notes = item.notes;
  }

  return dto;
}

function storedWishPrice(value: unknown): WishPrice | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as { amount?: unknown; currency?: unknown };
  if (typeof raw.amount !== 'number' || !Number.isFinite(raw.amount)) {
    return undefined;
  }
  if (typeof raw.currency !== 'string' || !raw.currency.trim()) {
    return undefined;
  }
  return { amount: raw.amount, currency: raw.currency.trim() };
}

async function signedWishImageUrl(
  objectKey: string,
): Promise<string | undefined> {
  try {
    const { imageUrl } = await createPresignedGetUrl({ objectKey });
    return imageUrl;
  } catch (error) {
    logger.warn('Failed to presign wish image GET URL', {
      objectKey,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return undefined;
  }
}

export interface WishListCursor {
  createdAt: string;
  wishId: string;
}

export function encodeWishCursor(cursor: WishListCursor): string {
  return Buffer.from(
    `${cursor.createdAt}\t${cursor.wishId}`,
    'utf8',
  ).toString('base64url');
}

export function decodeWishCursor(raw: string): WishListCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw Errors.validation('cursor is not valid.');
  }
  const split = decoded.indexOf('\t');
  if (split <= 0 || split === decoded.length - 1) {
    throw Errors.validation('cursor is not valid.');
  }
  const createdAt = decoded.slice(0, split);
  const wishId = decoded.slice(split + 1);
  if (!createdAt || !wishId) {
    throw Errors.validation('cursor is not valid.');
  }
  return { createdAt, wishId };
}

export function parseWishListLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_WISH_LIST_LIMIT;
  }
  if (!/^\d+$/.test(raw)) {
    throw Errors.validation('limit must be an integer.');
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_WISH_LIST_LIMIT) {
    throw Errors.validation(
      `limit must be between 1 and ${MAX_WISH_LIST_LIMIT}.`,
    );
  }
  return value;
}

/** Newest first: createdAt desc, then wishId desc. */
export function compareWishesNewestFirst(
  left: DynamoItem,
  right: DynamoItem,
): number {
  const byCreated = String(right.createdAt).localeCompare(String(left.createdAt));
  if (byCreated !== 0) {
    return byCreated;
  }
  return String(right.wishId).localeCompare(String(left.wishId));
}

export function isAfterWishCursor(
  item: DynamoItem,
  cursor: WishListCursor,
): boolean {
  const createdAt = String(item.createdAt);
  const wishId = String(item.wishId);
  const byCreated = cursor.createdAt.localeCompare(createdAt);
  if (byCreated !== 0) {
    return byCreated > 0;
  }
  return wishId < cursor.wishId;
}
