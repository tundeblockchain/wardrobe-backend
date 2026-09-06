import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import {
  deleteItem,
  getItem,
  getOwnedOutfit,
  getOwnedWardrobe,
  keys,
  putItem,
  queryByPk,
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
  routeKey,
} from '../../shared/http';
import { newOutfitId, nowIso } from '../../shared/ids';
import { logger } from '../../shared/logger';
import { enqueueRenderOutfit } from '../../shared/sqs';
import {
  DynamoItem,
  Outfit,
  OutfitItem,
  OutfitRender,
  OutfitSlot,
} from '../../shared/types';
import { requireNonEmptyString, requireOutfitItems } from '../../shared/validation';
import {
  clothingItemImageKey,
  pendingRender,
  requireReadyRenderableProfile,
  toOutfitRender,
  withSignedRenderUrl,
} from './render';

interface CreateOutfitBody {
  name?: unknown;
  items?: unknown;
  userId?: unknown;
}

interface UpdateOutfitBody {
  name?: unknown;
  items?: unknown;
  userId?: unknown;
}

interface RequestRenderBody {
  aiProfileId?: unknown;
  items?: unknown;
  itemIds?: unknown;
  userId?: unknown;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = getUserId(event);
    const method = event.requestContext.http.method;
    const wardrobeId = event.pathParameters?.wardrobeId?.trim();
    const outfitId = event.pathParameters?.outfitId?.trim();

    if (!wardrobeId) {
      throw Errors.validation('wardrobeId is required.');
    }

    if (isRenderRoute(event)) {
      if (!outfitId) {
        throw Errors.validation('outfitId is required.');
      }
      if (method === 'GET') {
        return ok(await getOutfitRender(userId, wardrobeId, outfitId));
      }
      if (method === 'POST') {
        return accepted(
          await requestOutfitRender(
            userId,
            wardrobeId,
            outfitId,
            parseJsonBody(event),
          ),
        );
      }
      throw Errors.validation(`Unsupported method: ${method}`);
    }

    if (!outfitId) {
      if (method === 'GET') {
        return ok({ outfits: await listOutfits(userId, wardrobeId) });
      }
      if (method === 'POST') {
        return created(
          await createOutfit(userId, wardrobeId, parseJsonBody(event)),
        );
      }
      throw Errors.validation(`Unsupported method: ${method}`);
    }

    if (method === 'GET') {
      return ok(
        await toOutfitDto(await getOwnedOutfit(userId, wardrobeId, outfitId), {
          signRenderUrl: true,
        }),
      );
    }

    if (method === 'PATCH') {
      return ok(
        await updateOutfit(userId, wardrobeId, outfitId, parseJsonBody(event)),
      );
    }

    if (method === 'DELETE') {
      await removeOutfit(userId, wardrobeId, outfitId);
      return noContent();
    }

    throw Errors.validation(`Unsupported method: ${method}`);
  } catch (error) {
    return errorResponse(error);
  }
}

function isRenderRoute(event: APIGatewayProxyEventV2): boolean {
  const key = routeKey(event);
  const path = event.rawPath ?? '';
  return (
    key.includes('/outfits/{outfitId}/render') ||
    (key.includes('/render') && key.includes('/outfits/')) ||
    /\/outfits\/[^/]+\/render\/?$/.test(path)
  );
}

async function listOutfits(
  userId: string,
  wardrobeId: string,
): Promise<Outfit[]> {
  await getOwnedWardrobe(userId, wardrobeId);
  const items = await queryByPk(keys.wardrobePk(wardrobeId), 'OUTFIT#');
  return items
    .filter(
      (item) =>
        item.entityType === 'OUTFIT' &&
        item.userId === userId &&
        item.wardrobeId === wardrobeId,
    )
    .map((item) => toOutfit(item));
}

async function createOutfit(
  userId: string,
  wardrobeId: string,
  body: CreateOutfitBody,
): Promise<Outfit> {
  await getOwnedWardrobe(userId, wardrobeId);

  const name = requireNonEmptyString(body.name, 'name');
  const items = requireOutfitItems(body.items);
  await assertItemsBelongToWardrobe(userId, wardrobeId, items);

  const outfitId = newOutfitId();
  const timestamp = nowIso();

  const item: DynamoItem = {
    PK: keys.wardrobePk(wardrobeId),
    SK: keys.outfitSk(outfitId),
    entityType: 'OUTFIT',
    userId,
    wardrobeId,
    outfitId,
    name,
    items,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await putItem(item);
  return toOutfit(item);
}

async function updateOutfit(
  userId: string,
  wardrobeId: string,
  outfitId: string,
  body: UpdateOutfitBody,
): Promise<Outfit> {
  await getOwnedOutfit(userId, wardrobeId, outfitId);

  const updates: Record<string, unknown> = {};

  if (body.name !== undefined) {
    updates.name = requireNonEmptyString(body.name, 'name');
  }
  if (body.items !== undefined) {
    const items = requireOutfitItems(body.items);
    await assertItemsBelongToWardrobe(userId, wardrobeId, items);
    updates.items = items;
  }

  if (Object.keys(updates).length === 0) {
    throw Errors.validation('At least one field is required.');
  }

  const updated = await updateAttributes(
    keys.wardrobePk(wardrobeId),
    keys.outfitSk(outfitId),
    { ...updates, updatedAt: nowIso() },
  );

  return toOutfitDto(updated, { signRenderUrl: true });
}

async function removeOutfit(
  userId: string,
  wardrobeId: string,
  outfitId: string,
): Promise<void> {
  await getOwnedOutfit(userId, wardrobeId, outfitId);
  await deleteItem(keys.wardrobePk(wardrobeId), keys.outfitSk(outfitId));
}

async function getOutfitRender(
  userId: string,
  wardrobeId: string,
  outfitId: string,
): Promise<OutfitRender> {
  const outfit = await getOwnedOutfit(userId, wardrobeId, outfitId);
  const render = toOutfitRender(outfit.render);
  if (!render) {
    throw Errors.renderNotFound();
  }
  return withSignedRenderUrl(render);
}

async function requestOutfitRender(
  userId: string,
  wardrobeId: string,
  outfitId: string,
  body: RequestRenderBody,
): Promise<Outfit> {
  const existing = await getOwnedOutfit(userId, wardrobeId, outfitId);
  const previousRender = existing.render;
  const aiProfileId = requireNonEmptyString(body.aiProfileId, 'aiProfileId');
  await requireReadyRenderableProfile(userId, aiProfileId);

  const items =
    body.items !== undefined
      ? requireOutfitItems(body.items)
      : resolveItemsFromIds(body.itemIds, existing);
  const garmentItems = items ?? toOutfitItems(existing.items);
  if (garmentItems.length === 0) {
    throw Errors.validation('Outfit must contain at least one item to render.');
  }

  await assertItemsBelongToWardrobe(userId, wardrobeId, garmentItems);
  await assertItemsHaveImages(userId, wardrobeId, garmentItems);

  const render = pendingRender(aiProfileId);
  const updates: Record<string, unknown> = {
    render,
    updatedAt: nowIso(),
  };
  if (body.items !== undefined || body.itemIds !== undefined) {
    updates.items = garmentItems;
  }

  const updated = await updateAttributes(
    keys.wardrobePk(wardrobeId),
    keys.outfitSk(outfitId),
    updates,
  );

  try {
    await enqueueRenderOutfit({
      userId,
      wardrobeId,
      outfitId,
      aiProfileId,
    });
  } catch (error) {
    try {
      await updateAttributes(keys.wardrobePk(wardrobeId), keys.outfitSk(outfitId), {
        render: previousRender ?? null,
        updatedAt: nowIso(),
      });
    } catch (compensateError) {
      logger.error('Failed to roll back outfit render after enqueue failure', {
        outfitId,
        wardrobeId,
        error:
          compensateError instanceof Error
            ? compensateError.message
            : 'unknown',
      });
    }
    throw error;
  }

  return toOutfitDto(updated, { signRenderUrl: true });
}

function resolveItemsFromIds(
  itemIds: unknown,
  existing: DynamoItem,
): OutfitItem[] | undefined {
  if (itemIds === undefined) {
    return undefined;
  }
  if (!Array.isArray(itemIds)) {
    throw Errors.validation('itemIds must be an array of strings.');
  }
  if (itemIds.length === 0) {
    throw Errors.validation('itemIds must contain at least one itemId.');
  }

  const current = toOutfitItems(existing.items);
  const byId = new Map(current.map((entry) => [entry.itemId, entry]));
  const resolved: OutfitItem[] = [];
  const seen = new Set<string>();

  itemIds.forEach((value, index) => {
    const itemId = requireNonEmptyString(value, `itemIds[${index}]`);
    if (seen.has(itemId)) {
      throw Errors.validation('itemIds must not contain duplicate values.');
    }
    seen.add(itemId);
    const known = byId.get(itemId);
    if (known) {
      resolved.push(known);
      return;
    }
    throw Errors.validation(
      `itemIds[${index}] is not on this outfit. Send items[{itemId, slot}] to replace the set.`,
    );
  });

  return resolved;
}

async function assertItemsBelongToWardrobe(
  userId: string,
  wardrobeId: string,
  items: OutfitItem[],
): Promise<void> {
  for (const { itemId } of items) {
    const item = await getItem(keys.wardrobePk(wardrobeId), keys.itemSk(itemId));
    if (
      !item ||
      item.entityType !== 'ITEM' ||
      item.userId !== userId ||
      item.wardrobeId !== wardrobeId
    ) {
      throw Errors.itemNotFound();
    }
  }
}

async function assertItemsHaveImages(
  userId: string,
  wardrobeId: string,
  items: OutfitItem[],
): Promise<void> {
  for (const { itemId } of items) {
    const item = await getItem(keys.wardrobePk(wardrobeId), keys.itemSk(itemId));
    if (!item || !clothingItemImageKey(item)) {
      throw Errors.validation(
        `Clothing item ${itemId} has no image to render.`,
      );
    }
  }
}

function toOutfit(item: DynamoItem): Outfit {
  const render = toOutfitRender(item.render);
  return {
    outfitId: String(item.outfitId),
    wardrobeId: String(item.wardrobeId),
    name: String(item.name),
    items: toOutfitItems(item.items),
    ...(render ? { render } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

async function toOutfitDto(
  item: DynamoItem,
  options: { signRenderUrl: boolean },
): Promise<Outfit> {
  const outfit = toOutfit(item);
  if (!options.signRenderUrl || !outfit.render) {
    return outfit;
  }
  return {
    ...outfit,
    render: await withSignedRenderUrl(outfit.render),
  };
}

function toOutfitItems(value: unknown): OutfitItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    const raw = (entry ?? {}) as { itemId?: unknown; slot?: unknown };
    return {
      itemId: String(raw.itemId ?? ''),
      slot: String(raw.slot ?? '') as OutfitSlot,
    };
  });
}
