import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import { deleteItem, keys, putItem } from '../../shared/dynamodb';
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
import {
  AccountDeleteResult,
  SubscriptionCancelResult,
} from '../../shared/types';
import { wipeUser } from '../../shared/wipe';
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

function isAppErrorCode(error: unknown, code: AppError['code']): boolean {
  return error instanceof AppError && error.code === code;
}
