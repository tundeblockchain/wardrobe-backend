import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import { deleteMany, getItem, keys, queryByPk } from '../../shared/dynamodb';
import { Errors } from '../../shared/errors';
import { errorResponse, ok, routeKey } from '../../shared/http';
import { deleteObjectsUnderUserPrefix } from '../../shared/s3';
import { DynamoItem, EntityType, UserWipeResult } from '../../shared/types';

/**
 * Owner-only account APIs.
 *
 * DELETE /me/content — wipe wardrobes, items, outfits, and S3 under users/{uid}/.
 *                      Firebase Auth user and session stay.
 * DELETE /me         — same Dynamo + S3 wipe (plus PROFILE if present), then
 *                      return OK so Flutter can delete the Firebase Auth user
 *                      client-side. This backend does not call Firebase Admin.
 *
 * Identity always comes from the Firebase authorizer (`getUserId`).
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = getUserId(event);
    const method = event.requestContext.http.method;
    if (method !== 'DELETE') {
      throw Errors.validation(`Unsupported method: ${method}`);
    }

    const key = routeKey(event);
    if (isContentRoute(key, event.rawPath)) {
      return ok(await wipeUser(userId, { keepAccount: true }));
    }
    if (isAccountRoute(key, event.rawPath)) {
      return ok(await wipeUser(userId, { keepAccount: false }));
    }

    throw Errors.validation(`Unsupported route: ${key}`);
  } catch (error) {
    return errorResponse(error);
  }
}

function isContentRoute(key: string, rawPath: string): boolean {
  return key.includes('/me/content') || rawPath.endsWith('/me/content');
}

function isAccountRoute(key: string, rawPath: string): boolean {
  return key === 'DELETE /me' || rawPath === '/me' || rawPath.endsWith('/me');
}

async function wipeUser(
  userId: string,
  options: { keepAccount: boolean },
): Promise<UserWipeResult> {
  const rows = await collectOwnedRows(userId, { includeProfile: !options.keepAccount });

  await deleteMany(rows.map(({ pk, sk }) => ({ pk, sk })));

  const s3 = await deleteObjectsUnderUserPrefix(userId);

  return {
    keepAccount: options.keepAccount,
    deletedWardrobes: countEntity(rows, 'WARDROBE'),
    deletedItems: countEntity(rows, 'ITEM'),
    deletedOutfits: countEntity(rows, 'OUTFIT'),
    deletedS3Objects: s3.deleted,
    s3Failures: s3.failed,
  };
}

interface RowKey {
  pk: string;
  sk: string;
  entityType: EntityType;
}

async function collectOwnedRows(
  userId: string,
  options: { includeProfile: boolean },
): Promise<RowKey[]> {
  const rows: RowKey[] = [];
  const seen = new Set<string>();

  const add = (pk: string, sk: string, entityType: EntityType): void => {
    const id = `${pk}\0${sk}`;
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    rows.push({ pk, sk, entityType });
  };

  const wardrobes = (await queryByPk(keys.userPk(userId), 'WARDROBE#')).filter(
    (item) => item.entityType === 'WARDROBE' && item.userId === userId,
  );

  for (const wardrobe of wardrobes) {
    const wardrobeId = String(wardrobe.wardrobeId);
    const children = await queryByPk(keys.wardrobePk(wardrobeId));
    for (const child of children) {
      if (child.userId !== userId) {
        continue;
      }
      if (child.entityType === 'ITEM' || child.entityType === 'OUTFIT') {
        add(child.PK, child.SK, child.entityType);
      }
    }
    add(wardrobe.PK, wardrobe.SK, 'WARDROBE');
  }

  if (options.includeProfile) {
    const profile = await getItem(keys.userPk(userId), keys.profileSk);
    if (ownedProfile(profile, userId)) {
      add(keys.userPk(userId), keys.profileSk, 'PROFILE');
    }
  }

  return rows;
}

function ownedProfile(
  profile: DynamoItem | undefined,
  userId: string,
): profile is DynamoItem {
  if (!profile) {
    return false;
  }
  if (profile.entityType && profile.entityType !== 'PROFILE') {
    return false;
  }
  if (typeof profile.userId === 'string' && profile.userId !== userId) {
    return false;
  }
  return true;
}

function countEntity(rows: RowKey[], entityType: EntityType): number {
  return rows.filter((row) => row.entityType === entityType).length;
}
