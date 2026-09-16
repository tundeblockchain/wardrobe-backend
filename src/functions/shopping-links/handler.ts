import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import { getOwnedItem, keys, queryByPk } from '../../shared/dynamodb';
import { Errors } from '../../shared/errors';
import { errorResponse, ok, routeKey } from '../../shared/http';
import {
  DynamoItem,
  HomeShoppingLinksResponse,
  ItemShoppingLinksResponse,
} from '../../shared/types';
import {
  ShoppingLinksPipelineDeps,
  isUpstreamFailure,
  resolveItemShoppingLinks,
} from './pipeline';
import { parseShoppingLinksQuery } from './query';

export interface ShoppingLinksHandlerDeps extends ShoppingLinksPipelineDeps {}

/**
 * GET /wardrobes/{wardrobeId}/items/{itemId}/shopping-links
 * GET /shopping-links?limit=5&linksPerItem=8
 *
 * Owner-only. Not entitlement-gated (WARDROBE-96). Free / Basic / Premium
 * may call. Identity comes from the Firebase authorizer.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  return handleShoppingLinks(event);
}

export async function handleShoppingLinks(
  event: APIGatewayProxyEventV2,
  deps: ShoppingLinksHandlerDeps = {},
): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = getUserId(event);
    const method = event.requestContext.http.method;
    if (method !== 'GET') {
      throw Errors.validation(`Unsupported method: ${method}`);
    }

    const key = routeKey(event);
    if (isItemShoppingRoute(key, event.rawPath)) {
      return ok(await itemShoppingLinks(userId, event, deps));
    }
    if (isHomeShoppingRoute(key, event.rawPath)) {
      return ok(await homeShoppingLinks(userId, event, deps));
    }

    throw Errors.validation(`Unsupported route: ${key}`);
  } catch (error) {
    return errorResponse(error);
  }
}

async function itemShoppingLinks(
  userId: string,
  event: APIGatewayProxyEventV2,
  deps: ShoppingLinksHandlerDeps,
): Promise<ItemShoppingLinksResponse> {
  const wardrobeId = event.pathParameters?.wardrobeId?.trim();
  const itemId = event.pathParameters?.itemId?.trim();
  if (!wardrobeId) {
    throw Errors.validation('wardrobeId is required.');
  }
  if (!itemId) {
    throw Errors.validation('itemId is required.');
  }

  const query = parseShoppingLinksQuery(event.queryStringParameters, {
    includeLimit: false,
  });
  const item = await getOwnedItem(userId, wardrobeId, itemId);
  return resolveItemShoppingLinks(userId, item, query.linksPerItem, deps);
}

async function homeShoppingLinks(
  userId: string,
  event: APIGatewayProxyEventV2,
  deps: ShoppingLinksHandlerDeps,
): Promise<HomeShoppingLinksResponse> {
  const query = parseShoppingLinksQuery(event.queryStringParameters, {
    includeLimit: true,
  });
  const recent = await listRecentOwnedItems(userId, query.limit);
  if (recent.length === 0) {
    return { items: [] };
  }

  const results = await Promise.all(
    recent.map((item) =>
      resolveItemShoppingLinks(userId, item, query.linksPerItem, deps),
    ),
  );

  const items = results.filter((result) => !isUpstreamFailure(result));
  return { items };
}

async function listRecentOwnedItems(
  userId: string,
  limit: number,
): Promise<DynamoItem[]> {
  const wardrobes = (await queryByPk(keys.userPk(userId), 'WARDROBE#')).filter(
    (row) => row.entityType === 'WARDROBE' && row.userId === userId,
  );

  const items: DynamoItem[] = [];
  for (const wardrobe of wardrobes) {
    const wardrobeId = String(wardrobe.wardrobeId);
    const children = await queryByPk(keys.wardrobePk(wardrobeId), 'ITEM#');
    for (const child of children) {
      if (
        child.entityType === 'ITEM' &&
        child.userId === userId &&
        child.wardrobeId === wardrobeId
      ) {
        items.push(child);
      }
    }
  }

  items.sort(compareItemsNewestFirst);
  return items.slice(0, limit);
}

function compareItemsNewestFirst(left: DynamoItem, right: DynamoItem): number {
  const rightStamp = right.updatedAt || right.createdAt || '';
  const leftStamp = left.updatedAt || left.createdAt || '';
  return rightStamp.localeCompare(leftStamp);
}

function isItemShoppingRoute(key: string, rawPath: string): boolean {
  return (
    key.includes('/items/{itemId}/shopping-links') ||
    /\/wardrobes\/[^/]+\/items\/[^/]+\/shopping-links$/.test(rawPath)
  );
}

function isHomeShoppingRoute(key: string, rawPath: string): boolean {
  return key === 'GET /shopping-links' || rawPath === '/shopping-links';
}
