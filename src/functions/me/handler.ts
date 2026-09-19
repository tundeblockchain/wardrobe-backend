import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import { deleteItem, deleteMany, getItem, keys, queryByPk } from '../../shared/dynamodb';
import {
  countUsage,
  loadStoredEntitlement,
  resolveEntitlement,
  StoredEntitlement,
  toEntitlementDto,
} from '../../shared/entitlements';
import { Errors } from '../../shared/errors';
import { errorResponse, ok, routeKey } from '../../shared/http';
import { logger } from '../../shared/logger';
import { deleteObjectsUnderUserPrefix } from '../../shared/s3';
import {
  AccountDeleteResult,
  DynamoItem,
  EntityType,
  SubscriptionCancelResult,
  UserWipeResult,
} from '../../shared/types';
import {
  CancelSubscriptionInput,
  cancelUserSubscription,
  SubscriptionCancelDeps,
} from './cancel';

export interface MeHandlerDeps {
  loadStoredEntitlement?: (userId: string) => Promise<StoredEntitlement | undefined>;
  cancelSubscription?: (
    input: CancelSubscriptionInput,
  ) => Promise<SubscriptionCancelResult>;
  cancelDeps?: SubscriptionCancelDeps;
}

/**
 * Owner-only account APIs.
 *
 * GET    /me         — current entitlement (WARDROBE-91). Flutter WARDROBE-90
 *                      reads this to soft-gate Superwall UX.
 * DELETE /me/content — wipe wardrobes, items, outfits, worn-on dates,
 *                      personal AI profiles, job-done events, device tokens,
 *                      and S3 under users/{uid}/. Entitlement + Firebase Auth
 *                      stay. No subscription cancel (WARDROBE-103).
 * DELETE /me         — cancel store subscription when possible, revoke
 *                      ENTITLEMENT, then the same Dynamo + S3 wipe (plus
 *                      PROFILE). Returns WARDROBE-102 outcome so Flutter can
 *                      delete the Firebase Auth user client-side. This backend
 *                      does not call Firebase Admin. Seeded GENERIC_MODEL
 *                      catalog rows are never deleted.
 *
 * Identity always comes from the Firebase authorizer (`getUserId`).
 */
export async function handler(
  event: APIGatewayProxyEventV2,
  deps: MeHandlerDeps = {},
): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = getUserId(event);
    const method = event.requestContext.http.method;
    const key = routeKey(event);

    if (method === 'GET') {
      if (isAccountRoute(key, event.rawPath) && !isContentRoute(key, event.rawPath)) {
        return ok(await getEntitlement(userId));
      }
      throw Errors.validation(`Unsupported route: ${key}`);
    }

    if (method !== 'DELETE') {
      throw Errors.validation(`Unsupported method: ${method}`);
    }

    if (isContentRoute(key, event.rawPath)) {
      return ok(await wipeUser(userId, { keepAccount: true }));
    }
    if (isAccountRoute(key, event.rawPath)) {
      return ok(await deleteAccount(userId, deps));
    }

    throw Errors.validation(`Unsupported route: ${key}`);
  } catch (error) {
    return errorResponse(error);
  }
}

async function getEntitlement(userId: string) {
  const stored = await resolveEntitlement(userId);
  const usage = await countUsage(userId);
  return toEntitlementDto(stored, usage);
}

async function deleteAccount(
  userId: string,
  deps: MeHandlerDeps,
): Promise<AccountDeleteResult> {
  const loadStored = deps.loadStoredEntitlement ?? loadStoredEntitlement;
  const entitlement = await loadStored(userId);
  const subscription = await attemptCancel(userId, entitlement, deps);

  await deleteItem(keys.userPk(userId), keys.entitlementSk);

  const wipe = await wipeUser(userId, {
    keepAccount: false,
    includeEntitlement: false,
  });

  return {
    deleted: true,
    keepAccount: false,
    entitlementRevoked: true,
    subscription: subscriptionDto(subscription),
    deletedWardrobes: wipe.deletedWardrobes,
    deletedItems: wipe.deletedItems,
    deletedOutfits: wipe.deletedOutfits,
    deletedAiProfiles: wipe.deletedAiProfiles,
    deletedS3Objects: wipe.deletedS3Objects,
    s3Failures: wipe.s3Failures,
  };
}

async function attemptCancel(
  userId: string,
  entitlement: StoredEntitlement | undefined,
  deps: MeHandlerDeps,
): Promise<SubscriptionCancelResult> {
  const cancel =
    deps.cancelSubscription ??
    ((input: CancelSubscriptionInput) =>
      cancelUserSubscription(input, deps.cancelDeps));
  try {
    return await cancel({ userId, entitlement });
  } catch (error) {
    logger.warn('Subscription cancel failed', {
      store: entitlement?.store ?? 'UNKNOWN',
      errorName: error instanceof Error ? error.name : 'UnknownError',
      reason: error instanceof Error ? error.message : 'unknown',
    });
    const failed: SubscriptionCancelResult = {
      status: 'CANCEL_FAILED',
      retryInStore: true,
    };
    if (entitlement?.store) {
      failed.store = entitlement.store;
    }
    if (entitlement?.expiresAt) {
      failed.expiresAt = entitlement.expiresAt;
    }
    return failed;
  }
}

function subscriptionDto(
  outcome: SubscriptionCancelResult,
): SubscriptionCancelResult {
  const dto: SubscriptionCancelResult = { status: outcome.status };
  if (outcome.cancelMode) {
    dto.cancelMode = outcome.cancelMode;
  }
  if (outcome.store) {
    dto.store = outcome.store;
  }
  if (outcome.expiresAt) {
    dto.expiresAt = outcome.expiresAt;
  }
  if (outcome.retryInStore === true) {
    dto.retryInStore = true;
  }
  return dto;
}

function isContentRoute(key: string, rawPath: string): boolean {
  return key.includes('/me/content') || rawPath.endsWith('/me/content');
}

function isAccountRoute(key: string, rawPath: string): boolean {
  return (
    key === 'GET /me' ||
    key === 'DELETE /me' ||
    rawPath === '/me' ||
    rawPath.endsWith('/me')
  );
}

async function wipeUser(
  userId: string,
  options: { keepAccount: boolean; includeEntitlement?: boolean },
): Promise<UserWipeResult> {
  const includeEntitlement =
    options.includeEntitlement ?? !options.keepAccount;

  const rows = await collectOwnedRows(userId, {
    includeProfile: !options.keepAccount,
    includeEntitlement,
  });

  await deleteMany(rows.map(({ pk, sk }) => ({ pk, sk })));

  const s3 = await deleteObjectsUnderUserPrefix(userId);

  return {
    keepAccount: options.keepAccount,
    deletedWardrobes: countEntity(rows, 'WARDROBE'),
    deletedItems: countEntity(rows, 'ITEM'),
    deletedOutfits: countEntity(rows, 'OUTFIT'),
    deletedAiProfiles: countEntity(rows, 'AIPROFILE'),
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
  options: { includeProfile: boolean; includeEntitlement: boolean },
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

  const personalProfiles = (
    await queryByPk(keys.userPk(userId), 'AIPROFILE#')
  ).filter(
    (item) => item.entityType === 'AIPROFILE' && item.userId === userId,
  );
  for (const profile of personalProfiles) {
    add(profile.PK, profile.SK, 'AIPROFILE');
  }

  const shoppingCaches = (
    await queryByPk(keys.userPk(userId), keys.shoppingCacheSkPrefix)
  ).filter(
    (item) => item.entityType === 'SHOPPING_CACHE' && item.userId === userId,
  );
  for (const cache of shoppingCaches) {
    add(cache.PK, cache.SK, 'SHOPPING_CACHE');
  }

  const jobEvents = (
    await queryByPk(keys.userPk(userId), keys.eventSkPrefix)
  ).filter((item) => item.entityType === 'JOB_EVENT' && item.userId === userId);
  for (const jobEvent of jobEvents) {
    add(jobEvent.PK, jobEvent.SK, 'JOB_EVENT');
  }

  const devices = (
    await queryByPk(keys.userPk(userId), keys.deviceSkPrefix)
  ).filter((item) => item.entityType === 'DEVICE' && item.userId === userId);
  for (const device of devices) {
    add(device.PK, device.SK, 'DEVICE');
  }

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
      if (
        child.entityType === 'ITEM' ||
        child.entityType === 'OUTFIT' ||
        child.entityType === 'WORN_ON'
      ) {
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

  if (options.includeEntitlement) {
    const entitlement = await getItem(keys.userPk(userId), keys.entitlementSk);
    if (ownedEntitlement(entitlement, userId)) {
      add(keys.userPk(userId), keys.entitlementSk, 'ENTITLEMENT');
    }
  }

  return rows;
}

function ownedEntitlement(
  item: DynamoItem | undefined,
  userId: string,
): item is DynamoItem {
  if (!item) {
    return false;
  }
  if (item.entityType && item.entityType !== 'ENTITLEMENT') {
    return false;
  }
  if (typeof item.userId === 'string' && item.userId !== userId) {
    return false;
  }
  return true;
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
