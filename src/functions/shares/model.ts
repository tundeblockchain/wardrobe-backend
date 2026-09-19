import { keys } from '../../shared/dynamodb';
import { newShareToken, nowIso } from '../../shared/ids';
import {
  DynamoItem,
  SHARE_RESOURCE_TYPES,
  SHARE_TTL_SECONDS,
  Share,
  SharePreview,
  ShareResourceType,
} from '../../shared/types';

/** Client path Flutter / Frontend append to their origin (WARDROBE-128 / 127). */
export const SHARE_PATH_PREFIX = '/share/';

/**
 * `shr_` + nanoid(21). Longer than wardrobe/item ids because this token is
 * the only secret on the public GET. Alphabet is URL-safe.
 */
export const SHARE_TOKEN_PATTERN = /^shr_[A-Za-z0-9_-]{21}$/;

export function sharePath(token: string): string {
  return `${SHARE_PATH_PREFIX}${token}`;
}

export function shareTtl(nowSeconds = Math.floor(Date.now() / 1000)): number {
  return nowSeconds + SHARE_TTL_SECONDS;
}

export function shareExpiresAt(now = new Date()): string {
  return new Date(now.getTime() + SHARE_TTL_SECONDS * 1000).toISOString();
}

export function isShareResourceType(
  value: unknown,
): value is ShareResourceType {
  return (
    typeof value === 'string' &&
    (SHARE_RESOURCE_TYPES as readonly string[]).includes(value)
  );
}

export function isShareToken(value: unknown): value is string {
  return typeof value === 'string' && SHARE_TOKEN_PATTERN.test(value.trim());
}

export function normalizeShareToken(value: string): string {
  return value.trim();
}

export interface CreateShareInput {
  userId: string;
  wardrobeId: string;
  resourceType: ShareResourceType;
  itemId?: string;
  outfitId?: string;
}

export function toShareItem(
  input: CreateShareInput,
  createdAt = nowIso(),
): DynamoItem {
  const token = newShareToken();
  const expiresAt = shareExpiresAt(new Date(createdAt));
  const item: DynamoItem = {
    PK: keys.sharePk(token),
    SK: keys.shareSk,
    GSI1PK: keys.gsi1ShareUserPk(input.userId),
    GSI1SK: keys.gsi1ShareSk(token),
    entityType: 'SHARE',
    userId: input.userId,
    wardrobeId: input.wardrobeId,
    resourceType: input.resourceType,
    token,
    expiresAt,
    createdAt,
    updatedAt: createdAt,
    ttl: shareTtl(Math.floor(new Date(createdAt).getTime() / 1000)),
  };
  if (input.resourceType === 'ITEM' && input.itemId) {
    item.itemId = input.itemId;
  }
  if (input.resourceType === 'OUTFIT' && input.outfitId) {
    item.outfitId = input.outfitId;
  }
  return item;
}

export function toShareDto(item: DynamoItem): Share {
  const token = String(item.token ?? '');
  const dto: Share = {
    token,
    resourceType: item.resourceType as ShareResourceType,
    wardrobeId: String(item.wardrobeId ?? ''),
    sharePath: sharePath(token),
    expiresAt: String(item.expiresAt ?? ''),
    createdAt: String(item.createdAt ?? ''),
  };
  if (dto.resourceType === 'ITEM' && typeof item.itemId === 'string' && item.itemId) {
    dto.itemId = item.itemId;
  }
  if (
    dto.resourceType === 'OUTFIT' &&
    typeof item.outfitId === 'string' &&
    item.outfitId
  ) {
    dto.outfitId = item.outfitId;
  }
  return dto;
}

export function toSharePreviewDto(
  item: DynamoItem,
  title: string,
  imageUrl?: string,
): SharePreview {
  const preview: SharePreview = {
    resourceType: item.resourceType as ShareResourceType,
    title,
    expiresAt: String(item.expiresAt ?? ''),
  };
  if (imageUrl) {
    preview.imageUrl = imageUrl;
  }
  return preview;
}

export function isShareItem(item: DynamoItem | undefined): item is DynamoItem {
  return (
    !!item &&
    item.entityType === 'SHARE' &&
    isShareResourceType(item.resourceType) &&
    typeof item.token === 'string' &&
    typeof item.userId === 'string'
  );
}

export function isOwnedShare(
  item: DynamoItem | undefined,
  userId: string,
): item is DynamoItem {
  return isShareItem(item) && item.userId === userId;
}

export function isShareRevoked(item: DynamoItem): boolean {
  return typeof item.revokedAt === 'string' && item.revokedAt.trim().length > 0;
}

export function isShareExpired(
  item: DynamoItem,
  nowMs = Date.now(),
): boolean {
  if (typeof item.expiresAt === 'string' && item.expiresAt.trim()) {
    const expiresMs = Date.parse(item.expiresAt);
    if (!Number.isNaN(expiresMs) && expiresMs <= nowMs) {
      return true;
    }
  }
  if (typeof item.ttl === 'number' && item.ttl <= Math.floor(nowMs / 1000)) {
    return true;
  }
  return false;
}

export function isShareGone(item: DynamoItem, nowMs = Date.now()): boolean {
  return isShareRevoked(item) || isShareExpired(item, nowMs);
}

/** Prefer processed cutout, then original photo. */
export function clothingPreviewImageKey(item: DynamoItem): string | undefined {
  if (typeof item.processedKey === 'string' && item.processedKey.trim()) {
    return item.processedKey.trim();
  }
  if (typeof item.originalKey === 'string' && item.originalKey.trim()) {
    return item.originalKey.trim();
  }
  return undefined;
}

/** READY try-on image when present. */
export function outfitRenderPreviewKey(outfit: DynamoItem): string | undefined {
  const render = outfit.render;
  if (!render || typeof render !== 'object' || Array.isArray(render)) {
    return undefined;
  }
  const raw = render as { status?: unknown; imageKey?: unknown };
  if (raw.status !== 'READY') {
    return undefined;
  }
  if (typeof raw.imageKey === 'string' && raw.imageKey.trim()) {
    return raw.imageKey.trim();
  }
  return undefined;
}

export function firstOutfitItemId(outfit: DynamoItem): string | undefined {
  if (!Array.isArray(outfit.items)) {
    return undefined;
  }
  for (const entry of outfit.items) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const itemId = (entry as { itemId?: unknown }).itemId;
    if (typeof itemId === 'string' && itemId.trim()) {
      return itemId.trim();
    }
  }
  return undefined;
}
