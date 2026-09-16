import { createHash } from 'crypto';
import { getItem, keys, putItem } from '../../shared/dynamodb';
import { nowIso } from '../../shared/ids';
import { logger } from '../../shared/logger';
import {
  DynamoItem,
  SHOPPING_LINKS_CACHE_TTL_SECONDS,
  ShoppingLink,
} from '../../shared/types';
import { itemMetadataForKeywords, preferredItemImageKey } from './keywords';

export interface ShoppingCacheEntry {
  userId: string;
  itemId: string;
  wardrobeId: string;
  cacheKey: string;
  imageKey?: string;
  keywords: string[];
  query?: string;
  links: ShoppingLink[];
  createdAt: string;
  updatedAt: string;
  ttl: number;
}

export interface ShoppingCacheStore {
  read(userId: string, itemId: string): Promise<ShoppingCacheEntry | undefined>;
  write(entry: ShoppingCacheEntry): Promise<void>;
}

export function shoppingCacheTtlSeconds(): number {
  const raw = process.env.SHOPPING_LINKS_CACHE_TTL_SECONDS?.trim();
  if (!raw) {
    return SHOPPING_LINKS_CACHE_TTL_SECONDS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : SHOPPING_LINKS_CACHE_TTL_SECONDS;
}

export function buildShoppingCacheKey(input: {
  userId: string;
  itemId: string;
  imageKey?: string;
  keywords?: string[];
  query?: string;
  item?: DynamoItem;
}): string {
  const metadata = input.item ? itemMetadataForKeywords(input.item) : {};
  const keywords = (input.keywords ?? []).map((word) => word.trim().toLowerCase()).sort();
  const payload = [
    input.userId,
    input.itemId,
    input.imageKey ?? '',
    JSON.stringify(metadata),
    keywords.join('|'),
    input.query ?? '',
  ].join('\0');
  return createHash('sha256').update(payload).digest('hex');
}

export function lookupShoppingCacheKey(item: DynamoItem, userId: string): string {
  return buildShoppingCacheKey({
    userId,
    itemId: String(item.itemId),
    imageKey: preferredItemImageKey(item),
    item,
  });
}

export function isFreshShoppingCache(
  entry: ShoppingCacheEntry | undefined,
  cacheKey: string,
  nowMs: number,
): entry is ShoppingCacheEntry {
  if (!entry) {
    return false;
  }
  if (entry.cacheKey !== cacheKey) {
    return false;
  }
  return entry.ttl * 1000 > nowMs;
}

export function shoppingCacheFromItem(
  item: DynamoItem,
): ShoppingCacheEntry | undefined {
  if (item.entityType !== 'SHOPPING_CACHE') {
    return undefined;
  }
  if (typeof item.itemId !== 'string' || typeof item.userId !== 'string') {
    return undefined;
  }
  if (typeof item.wardrobeId !== 'string' || typeof item.cacheKey !== 'string') {
    return undefined;
  }
  if (!Array.isArray(item.links) || typeof item.ttl !== 'number') {
    return undefined;
  }

  const keywords = Array.isArray(item.keywords)
    ? item.keywords.filter((value): value is string => typeof value === 'string')
    : [];
  const links = item.links.filter(isStoredShoppingLink);

  const entry: ShoppingCacheEntry = {
    userId: item.userId,
    itemId: item.itemId,
    wardrobeId: item.wardrobeId,
    cacheKey: item.cacheKey,
    keywords,
    links,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ttl: item.ttl,
  };
  if (typeof item.imageKey === 'string' && item.imageKey.trim()) {
    entry.imageKey = item.imageKey;
  }
  if (typeof item.query === 'string' && item.query.trim()) {
    entry.query = item.query;
  }
  return entry;
}

export function createDynamoShoppingCacheStore(): ShoppingCacheStore {
  return {
    async read(userId, itemId) {
      const item = await getItem(
        keys.userPk(userId),
        keys.shoppingCacheSk(itemId),
      );
      return item ? shoppingCacheFromItem(item) : undefined;
    },
    async write(entry) {
      try {
        await putItem({
          PK: keys.userPk(entry.userId),
          SK: keys.shoppingCacheSk(entry.itemId),
          entityType: 'SHOPPING_CACHE',
          userId: entry.userId,
          itemId: entry.itemId,
          wardrobeId: entry.wardrobeId,
          cacheKey: entry.cacheKey,
          imageKey: entry.imageKey,
          keywords: entry.keywords,
          query: entry.query,
          links: entry.links,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          ttl: entry.ttl,
        });
      } catch (error) {
        logger.warn('Shopping-links cache write failed', {
          itemId: entry.itemId,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    },
  };
}

export function newShoppingCacheEntry(input: {
  userId: string;
  item: DynamoItem;
  cacheKey: string;
  keywords: string[];
  query: string;
  links: ShoppingLink[];
  nowMs: number;
}): ShoppingCacheEntry {
  const timestamp = nowIso();
  const imageKey = preferredItemImageKey(input.item);
  const entry: ShoppingCacheEntry = {
    userId: input.userId,
    itemId: String(input.item.itemId),
    wardrobeId: String(input.item.wardrobeId),
    cacheKey: input.cacheKey,
    keywords: input.keywords,
    query: input.query,
    links: input.links,
    createdAt: timestamp,
    updatedAt: timestamp,
    ttl: Math.floor(input.nowMs / 1000) + shoppingCacheTtlSeconds(),
  };
  if (imageKey) {
    entry.imageKey = imageKey;
  }
  return entry;
}

function isStoredShoppingLink(value: unknown): value is ShoppingLink {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const rec = value as { title?: unknown; url?: unknown };
  return typeof rec.title === 'string' && typeof rec.url === 'string';
}
