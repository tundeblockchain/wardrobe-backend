import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import {
  deleteItem,
  deleteManyBatched,
  keys,
  putItem,
  queryByGsi1,
  queryByPk,
} from '../../shared/dynamodb';
import {
  countUsage,
  ensureFreeEntitlement,
  loadStoredEntitlement,
  StoredEntitlement,
  toEntitlementDto,
} from '../../shared/entitlements';
import { AppError, Errors } from '../../shared/errors';
import { deleteFirebaseAuthUser } from '../../shared/firebase-admin-auth';
import { errorResponse, ok, routeKey } from '../../shared/http';
import { nowIso } from '../../shared/ids';
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
  deleteAuthUser?: (uid: string) => Promise<void>;
}

/**
 * Owner-only account APIs.
 *
 * GET    /me         — current entitlement (WARDROBE-91 / WARDROBE-159).
 *                      Flutter WARDROBE-90 reads this to soft-gate Superwall
 *                      UX. The first call for an account writes FREE / NONE
 *                      at SK=ENTITLEMENT. Superwall appends history rows;
 *                      this handler always returns the latest record.
 * DELETE /me/content — wipe wardrobes, items, outfits, worn-on dates,
 *                      personal AI profiles, job-done events, device tokens,
 *                      share tokens, and S3 under users/{uid}/. Entitlement +
 *                      Firebase Auth stay. No subscription cancel (WARDROBE-103).
 * DELETE /me         — cancel store subscription when possible, revoke
 *                      ENTITLEMENT, wipe Dynamo + S3 (plus PROFILE), then
 *                      delete the Firebase Auth user with Admin SDK
 *                      (WARDROBE-154). Data first, Auth last, so a retry can
 *                      still authenticate. Seeded GENERIC_MODEL catalog rows
 *                      are never deleted.
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
  const stored = await ensureFreeEntitlement(userId);
  const usage = await countUsage(userId);
  return toEntitlementDto(stored, usage);
}

async function deleteAccount(
  userId: string,
  deps: MeHandlerDeps,
): Promise<AccountDeleteResult> {
  const loadStored = deps.loadStoredEntitlement ?? loadStoredEntitlement;
  const entitlement = await loadStored(userId);
  await attemptCancel(userId, entitlement, deps);

  try {
    await wipeUser(userId, {
      keepAccount: false,
      includeEntitlement: true,
      requireS3Success: true,
    });
    await writeDeletionMarker(userId);
  } catch (error) {
    if (isAppErrorCode(error, 'ACCOUNT_DELETION_FAILED')) {
      throw error;
    }
    logger.error('Account data deletion failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      reason: error instanceof Error ? error.message : 'unknown',
    });
    throw Errors.accountDeletionFailed();
  }

  try {
    const deleteAuth = deps.deleteAuthUser ?? deleteFirebaseAuthUser;
    await deleteAuth(userId);
  } catch (error) {
    if (isAppErrorCode(error, 'AUTH_DELETION_FAILED')) {
      throw error;
    }
    logger.warn('Firebase Auth user delete failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      reason: error instanceof Error ? error.message : 'unknown',
    });
    throw Errors.authDeletionFailed();
  }

  try {
    await deleteItem(keys.userPk(userId), keys.deletionSk);
  } catch (error) {
    logger.warn('Account deletion marker cleanup failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
  return { deleted: true };
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
  options: {
    keepAccount: boolean;
    includeEntitlement?: boolean;
    requireS3Success?: boolean;
  },
): Promise<UserWipeResult> {
  const includeEntitlement =
    options.includeEntitlement ?? !options.keepAccount;

  const rows = await collectOwnedRows(userId, {
    includeProfile: !options.keepAccount,
    includeEntitlement,
  });

  await deleteManyBatched(rows.map(({ pk, sk }) => ({ pk, sk })));

  const s3 = await deleteObjectsUnderUserPrefix(userId);
  if (options.requireS3Success && s3.failed > 0) {
    throw Errors.accountDeletionFailed(
      'Account media could not be deleted. Please try again.',
    );
  }

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

  const userRows = await queryByPk(keys.userPk(userId));
  for (const item of userRows) {
    if (!ownedUserPartitionRow(item, userId)) {
      continue;
    }
    if (!options.includeProfile && isProfileRow(item)) {
      continue;
    }
    if (!options.includeEntitlement && isEntitlementRow(item)) {
      continue;
    }
    add(item.PK, item.SK, item.entityType);
  }

  const shares = (
    await queryByGsi1(keys.gsi1ShareUserPk(userId), {
      skPrefix: keys.gsi1ShareSkPrefix,
    })
  ).filter((item) => item.entityType === 'SHARE' && item.userId === userId);
  for (const share of shares) {
    add(share.PK, share.SK, 'SHARE');
  }

  const wardrobes = userRows.filter(
    (item) => item.entityType === 'WARDROBE' && item.userId === userId,
  );

  for (const wardrobe of wardrobes) {
    const wardrobeId = String(wardrobe.wardrobeId);
    const children = await queryByPk(keys.wardrobePk(wardrobeId));
    for (const child of children) {
      if (child.userId !== userId) {
        continue;
      }
      add(child.PK, child.SK, child.entityType);
    }
  }

  return rows;
}

async function writeDeletionMarker(userId: string): Promise<void> {
  const now = nowIso();
  await putItem({
    PK: keys.userPk(userId),
    SK: keys.deletionSk,
    entityType: 'ACCOUNT_DELETION',
    userId,
    status: 'DATA_DELETED',
    createdAt: now,
    updatedAt: now,
  });
}

function ownedUserPartitionRow(item: DynamoItem, userId: string): boolean {
  if (item.PK !== keys.userPk(userId)) {
    return false;
  }
  if (typeof item.userId === 'string' && item.userId !== userId) {
    return false;
  }
  return true;
}

function isEntitlementRow(item: DynamoItem): boolean {
  return (
    item.entityType === 'ENTITLEMENT' ||
    item.SK === keys.entitlementSk ||
    item.SK.startsWith(`${keys.entitlementSkPrefix}#`)
  );
}

function isProfileRow(item: DynamoItem): boolean {
  return item.entityType === 'PROFILE' || item.SK === keys.profileSk;
}

function isAppErrorCode(error: unknown, code: AppError['code']): boolean {
  return error instanceof AppError && error.code === code;
}

function countEntity(rows: RowKey[], entityType: EntityType): number {
  return rows.filter((row) => row.entityType === entityType).length;
}
