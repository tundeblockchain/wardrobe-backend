import { getObjectBytes } from '../../shared/s3';
import { logger } from '../../shared/logger';
import {
  DynamoItem,
  SHOPPING_UPSTREAM_WARNING_CODE,
  ShoppingLinksItemResult,
  ShoppingLinksWarning,
} from '../../shared/types';
import {
  ShoppingCacheStore,
  createDynamoShoppingCacheStore,
  isFreshShoppingCache,
  lookupShoppingCacheKey,
  newShoppingCacheEntry,
} from './cache';
import {
  ItemImageBytes,
  KeywordExtractor,
  createOpenAiKeywordExtractor,
  preferredItemImageKey,
} from './keywords';
import {
  ShoppingSerpClient,
  brightDataFailureLogFields,
  buildShoppingQuery,
  createBrightDataSerpClient,
} from './serp';

const UPSTREAM_WARNING: ShoppingLinksWarning = {
  code: SHOPPING_UPSTREAM_WARNING_CODE,
  message: 'Shopping links are temporarily unavailable.',
};

export interface ShoppingLinksPipelineDeps {
  keywords?: KeywordExtractor;
  serp?: ShoppingSerpClient;
  cache?: ShoppingCacheStore;
  getImage?: (objectKey: string) => Promise<ItemImageBytes>;
  nowMs?: () => number;
}

export function resultFromCache(
  entry: {
    itemId: string;
    wardrobeId: string;
    keywords: string[];
    links: ShoppingLinkLike[];
  },
  options: { warning?: ShoppingLinksWarning } = {},
): ShoppingLinksItemResult {
  const result: ShoppingLinksItemResult = {
    itemId: entry.itemId,
    wardrobeId: entry.wardrobeId,
    keywords: entry.keywords,
    cached: true,
    links: entry.links.map(cloneLink),
  };
  if (options.warning) {
    result.warning = options.warning;
  }
  return result;
}

export function emptyShoppingResult(
  item: DynamoItem,
  options: { warning?: ShoppingLinksWarning; keywords?: string[] } = {},
): ShoppingLinksItemResult {
  const result: ShoppingLinksItemResult = {
    itemId: String(item.itemId),
    wardrobeId: String(item.wardrobeId),
    keywords: options.keywords ?? [],
    cached: false,
    links: [],
  };
  if (options.warning) {
    result.warning = options.warning;
  }
  return result;
}

export async function resolveItemShoppingLinks(
  userId: string,
  item: DynamoItem,
  linksPerItem: number,
  deps: ShoppingLinksPipelineDeps = {},
): Promise<ShoppingLinksItemResult> {
  const cache = deps.cache ?? createDynamoShoppingCacheStore();
  const nowMs = (deps.nowMs ?? Date.now)();
  const lookupKey = lookupShoppingCacheKey(item, userId);
  const stored = await cache.read(userId, String(item.itemId));

  if (isFreshShoppingCache(stored, lookupKey, nowMs)) {
    return resultFromCache(stored);
  }

  try {
    const keywordsClient = deps.keywords ?? createOpenAiKeywordExtractor();
    const image = await loadItemImage(item, deps.getImage);
    const keywords = await keywordsClient.extract({ item, image });
    const serp = deps.serp ?? createBrightDataSerpClient();
    const query = buildShoppingQuery(keywords);
    const links = await serp.search({
      keywords,
      metadataQuery: query,
      maxLinks: linksPerItem,
    });

    const storeKey = lookupShoppingCacheKey(item, userId);
    await cache.write(
      newShoppingCacheEntry({
        userId,
        item,
        cacheKey: storeKey,
        keywords,
        query,
        links,
        nowMs,
      }),
    );

    return {
      itemId: String(item.itemId),
      wardrobeId: String(item.wardrobeId),
      keywords,
      cached: false,
      links,
    };
  } catch (error) {
    logger.warn('Shopping-links upstream unavailable', {
      itemId: item.itemId,
      error: error instanceof Error ? error.message : 'unknown',
      ...brightDataFailureLogFields(error),
    });
    if (stored) {
      return resultFromCache(stored, { warning: UPSTREAM_WARNING });
    }
    return emptyShoppingResult(item, { warning: UPSTREAM_WARNING });
  }
}

export function isUpstreamFailure(result: ShoppingLinksItemResult): boolean {
  return (
    result.links.length === 0 &&
    result.warning?.code === SHOPPING_UPSTREAM_WARNING_CODE &&
    !result.cached
  );
}

async function loadItemImage(
  item: DynamoItem,
  getImage?: (objectKey: string) => Promise<ItemImageBytes>,
): Promise<ItemImageBytes | undefined> {
  const objectKey = preferredItemImageKey(item);
  if (!objectKey) {
    return undefined;
  }
  try {
    const loaded = getImage
      ? await getImage(objectKey)
      : await getObjectBytes(objectKey);
    return {
      bytes: loaded.bytes,
      contentType: loaded.contentType,
    };
  } catch (error) {
    logger.warn('Shopping-links S3 image read failed; continuing with metadata', {
      itemId: item.itemId,
      objectKey,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return undefined;
  }
}

type ShoppingLinkLike = {
  title: string;
  url: string;
  merchant?: string;
  price?: string;
  currency?: string;
  imageUrl?: string;
};

function cloneLink(link: ShoppingLinkLike): ShoppingLinkLike {
  const cloned: ShoppingLinkLike = { title: link.title, url: link.url };
  if (link.merchant) {
    cloned.merchant = link.merchant;
  }
  if (link.price) {
    cloned.price = link.price;
  }
  if (link.currency) {
    cloned.currency = link.currency;
  }
  if (link.imageUrl) {
    cloned.imageUrl = link.imageUrl;
  }
  return cloned;
}
