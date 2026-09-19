import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  deleteItem,
  deleteMany,
  getItem,
  getOwnedOutfit,
  getOwnedWardrobe,
  keys,
  putItem,
  queryByPk,
} from '../../shared/dynamodb';
import { Errors } from '../../shared/errors';
import {
  created,
  noContent,
  ok,
  parseJsonBody,
  routeKey,
} from '../../shared/http';
import { nowIso } from '../../shared/ids';
import {
  DynamoItem,
  OutfitWornOn,
  OutfitWornOnList,
} from '../../shared/types';
import { optionalIsoDate, requireIsoDate } from '../../shared/validation';

interface SetWornOnBody {
  wornOn?: unknown;
  userId?: unknown;
}

export function isWornOnRoute(event: APIGatewayProxyEventV2): boolean {
  const key = routeKey(event);
  const path = event.rawPath ?? '';
  return key.includes('/worn-on') || /\/worn-on(?:\/|$)/.test(path);
}

function isOutfitWornOnPath(event: APIGatewayProxyEventV2): boolean {
  const key = routeKey(event);
  const path = event.rawPath ?? '';
  return (
    key.includes('/outfits/{outfitId}/worn-on') ||
    /\/outfits\/[^/]+\/worn-on/.test(path)
  );
}

export async function handleWornOn(
  event: APIGatewayProxyEventV2,
  userId: string,
  wardrobeId: string,
  outfitId: string | undefined,
): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;

  if (!isOutfitWornOnPath(event)) {
    if (method === 'GET') {
      return ok(
        await listWardrobeWornOn(userId, wardrobeId, event.queryStringParameters),
      );
    }
    throw Errors.validation(`Unsupported method: ${method}`);
  }

  if (!outfitId) {
    throw Errors.validation('outfitId is required.');
  }

  const dateParam = event.pathParameters?.date?.trim();

  if (dateParam) {
    if (method === 'DELETE') {
      await removeWornOn(userId, wardrobeId, outfitId, dateParam);
      return noContent();
    }
    throw Errors.validation(`Unsupported method: ${method}`);
  }

  if (method === 'GET') {
    return ok(await listOutfitWornOn(userId, wardrobeId, outfitId));
  }

  if (method === 'POST') {
    const { entry, created: isNew } = await setWornOn(
      userId,
      wardrobeId,
      outfitId,
      parseJsonBody(event),
    );
    return isNew ? created(entry) : ok(entry);
  }

  throw Errors.validation(`Unsupported method: ${method}`);
}

export async function deleteWornOnForOutfit(
  userId: string,
  wardrobeId: string,
  outfitId: string,
): Promise<void> {
  const rows = await queryWornOnForOutfit(userId, wardrobeId, outfitId);
  if (rows.length === 0) {
    return;
  }
  await deleteMany(rows.map((row) => ({ pk: row.PK, sk: row.SK })));
}

async function listOutfitWornOn(
  userId: string,
  wardrobeId: string,
  outfitId: string,
): Promise<OutfitWornOnList> {
  await getOwnedOutfit(userId, wardrobeId, outfitId);
  const entries = (await queryWornOnForOutfit(userId, wardrobeId, outfitId)).map(
    toWornOn,
  );
  return { entries: sortEntries(entries) };
}

async function listWardrobeWornOn(
  userId: string,
  wardrobeId: string,
  query: APIGatewayProxyEventV2['queryStringParameters'],
): Promise<OutfitWornOnList> {
  const from = optionalIsoDate(query?.from, 'from');
  const to = optionalIsoDate(query?.to, 'to');
  if (from && to && from > to) {
    throw Errors.validation('from must be on or before to.');
  }

  await getOwnedWardrobe(userId, wardrobeId);

  const items = await queryByPk(keys.wardrobePk(wardrobeId), 'OUTFIT#');
  const entries = items
    .filter((item) => isOwnedWornOn(item, userId, wardrobeId))
    .map(toWornOn)
    .filter((entry) => inDateRange(entry.wornOn, from, to));

  return { entries: sortEntries(entries) };
}

async function setWornOn(
  userId: string,
  wardrobeId: string,
  outfitId: string,
  body: SetWornOnBody,
): Promise<{ entry: OutfitWornOn; created: boolean }> {
  const wornOn = requireIsoDate(body.wornOn, 'wornOn');
  await getOwnedOutfit(userId, wardrobeId, outfitId);
  const existing = await getItem(
    keys.wardrobePk(wardrobeId),
    keys.outfitWornOnSk(outfitId, wornOn),
  );
  if (existing && isOwnedWornOn(existing, userId, wardrobeId, outfitId)) {
    return { entry: toWornOn(existing), created: false };
  }

  const timestamp = nowIso();
  const item: DynamoItem = {
    PK: keys.wardrobePk(wardrobeId),
    SK: keys.outfitWornOnSk(outfitId, wornOn),
    entityType: 'WORN_ON',
    userId,
    wardrobeId,
    outfitId,
    wornOn,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await putItem(item);
  return { entry: toWornOn(item), created: true };
}

async function removeWornOn(
  userId: string,
  wardrobeId: string,
  outfitId: string,
  rawDate: string,
): Promise<void> {
  const wornOn = requireIsoDate(rawDate, 'date');
  await getOwnedOutfit(userId, wardrobeId, outfitId);
  const existing = await getItem(
    keys.wardrobePk(wardrobeId),
    keys.outfitWornOnSk(outfitId, wornOn),
  );
  if (!existing || !isOwnedWornOn(existing, userId, wardrobeId, outfitId)) {
    return;
  }
  await deleteItem(keys.wardrobePk(wardrobeId), keys.outfitWornOnSk(outfitId, wornOn));
}

async function queryWornOnForOutfit(
  userId: string,
  wardrobeId: string,
  outfitId: string,
): Promise<DynamoItem[]> {
  const items = await queryByPk(
    keys.wardrobePk(wardrobeId),
    keys.outfitWornOnSkPrefix(outfitId),
  );
  return items.filter((item) =>
    isOwnedWornOn(item, userId, wardrobeId, outfitId),
  );
}

function isOwnedWornOn(
  item: DynamoItem,
  userId: string,
  wardrobeId: string,
  outfitId?: string,
): boolean {
  if (item.entityType !== 'WORN_ON') {
    return false;
  }
  if (item.userId !== userId || item.wardrobeId !== wardrobeId) {
    return false;
  }
  if (outfitId !== undefined && item.outfitId !== outfitId) {
    return false;
  }
  return true;
}

function toWornOn(item: DynamoItem): OutfitWornOn {
  return {
    outfitId: String(item.outfitId),
    wardrobeId: String(item.wardrobeId),
    wornOn: String(item.wornOn),
    createdAt: String(item.createdAt),
  };
}

function inDateRange(
  wornOn: string,
  from: string | undefined,
  to: string | undefined,
): boolean {
  if (from && wornOn < from) {
    return false;
  }
  if (to && wornOn > to) {
    return false;
  }
  return true;
}

function sortEntries(entries: OutfitWornOn[]): OutfitWornOn[] {
  return [...entries].sort((left, right) => {
    if (left.wornOn !== right.wornOn) {
      return right.wornOn.localeCompare(left.wornOn);
    }
    return left.outfitId.localeCompare(right.outfitId);
  });
}
