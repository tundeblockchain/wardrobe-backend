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
  created,
  errorResponse,
  noContent,
  ok,
  parseJsonBody,
} from '../../shared/http';
import { newOutfitId, nowIso } from '../../shared/ids';
import {
  DynamoItem,
  Outfit,
  OutfitItem,
  OutfitSlot,
} from '../../shared/types';
import { requireNonEmptyString, requireOutfitItems } from '../../shared/validation';

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
      return ok(toOutfit(await getOwnedOutfit(userId, wardrobeId, outfitId)));
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
    .map(toOutfit);
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

  return toOutfit(updated);
}

async function removeOutfit(
  userId: string,
  wardrobeId: string,
  outfitId: string,
): Promise<void> {
  await getOwnedOutfit(userId, wardrobeId, outfitId);
  await deleteItem(keys.wardrobePk(wardrobeId), keys.outfitSk(outfitId));
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

function toOutfit(item: DynamoItem): Outfit {
  return {
    outfitId: String(item.outfitId),
    wardrobeId: String(item.wardrobeId),
    name: String(item.name),
    items: toOutfitItems(item.items),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
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
