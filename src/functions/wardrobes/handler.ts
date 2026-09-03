import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import {
  deleteItem,
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
import { newWardrobeId, nowIso } from '../../shared/ids';
import { DynamoItem, Wardrobe } from '../../shared/types';
import { requireNonEmptyString } from '../../shared/validation';

interface CreateWardrobeBody {
  name?: unknown;
}

interface UpdateWardrobeBody {
  name?: unknown;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = getUserId(event);
    const method = event.requestContext.http.method;
    const wardrobeId = event.pathParameters?.wardrobeId;

    if (method === 'GET' && !wardrobeId) {
      return ok({ wardrobes: await listWardrobes(userId) });
    }

    if (method === 'POST' && !wardrobeId) {
      return created(await createWardrobe(userId, parseJsonBody(event)));
    }

    if (!wardrobeId) {
      throw Errors.validation('wardrobeId is required.');
    }

    if (method === 'GET') {
      return ok(toWardrobe(await getOwnedWardrobe(userId, wardrobeId)));
    }

    if (method === 'PATCH') {
      return ok(await updateWardrobe(userId, wardrobeId, parseJsonBody(event)));
    }

    if (method === 'DELETE') {
      await deleteWardrobe(userId, wardrobeId);
      return noContent();
    }

    throw Errors.validation(`Unsupported method: ${method}`);
  } catch (error) {
    return errorResponse(error);
  }
}

async function listWardrobes(userId: string): Promise<Wardrobe[]> {
  const items = await queryByPk(keys.userPk(userId), 'WARDROBE#');
  return items
    .filter((item) => item.entityType === 'WARDROBE')
    .map(toWardrobe);
}

async function createWardrobe(
  userId: string,
  body: CreateWardrobeBody,
): Promise<Wardrobe> {
  const name = requireNonEmptyString(body.name, 'name');
  const wardrobeId = newWardrobeId();
  const timestamp = nowIso();

  const item: DynamoItem = {
    PK: keys.userPk(userId),
    SK: keys.wardrobeSk(wardrobeId),
    entityType: 'WARDROBE',
    userId,
    wardrobeId,
    name,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await putItem(item);
  return toWardrobe(item);
}

async function updateWardrobe(
  userId: string,
  wardrobeId: string,
  body: UpdateWardrobeBody,
): Promise<Wardrobe> {
  await getOwnedWardrobe(userId, wardrobeId);
  const name = requireNonEmptyString(body.name, 'name');

  const updated = await updateAttributes(
    keys.userPk(userId),
    keys.wardrobeSk(wardrobeId),
    { name, updatedAt: nowIso() },
  );

  return toWardrobe(updated);
}

async function deleteWardrobe(userId: string, wardrobeId: string): Promise<void> {
  await getOwnedWardrobe(userId, wardrobeId);
  await deleteItem(keys.userPk(userId), keys.wardrobeSk(wardrobeId));
}

function toWardrobe(item: DynamoItem): Wardrobe {
  return {
    wardrobeId: String(item.wardrobeId),
    name: String(item.name),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}
