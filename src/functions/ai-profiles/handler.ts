import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import {
  deleteItem,
  findGenericAiProfile,
  getOwnedPersonalAiProfile,
  getReadableAiProfile,
  isAiProfileItem,
  isPersonalAiProfile,
  keys,
  putItem,
  queryByGsi1,
  queryByPk,
} from '../../shared/dynamodb';
import { Errors } from '../../shared/errors';
import {
  created,
  errorResponse,
  noContent,
  ok,
  parseOptionalJsonBody,
  routeKey,
} from '../../shared/http';
import { newAiProfileId, nowIso } from '../../shared/ids';
import { AiProfile, AiProfileList } from '../../shared/types';
import {
  optionalAiProfileType,
  optionalReferenceImages,
  requireCreatePersonalType,
} from '../../shared/validation';
import { buildPersonalAiProfile, toAiProfile } from './model';

interface CreateAiProfileBody {
  type?: unknown;
  referenceImages?: unknown;
  userId?: unknown;
  status?: unknown;
}

/**
 * Authenticated AI Profile CRUD (WARDROBE-43).
 *
 * Identity comes from the Firebase authorizer (`getUserId`). Body / query /
 * path `userId` is ignored.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = getUserId(event);
    const method = event.requestContext.http.method;
    const aiProfileId = event.pathParameters?.aiProfileId?.trim();

    if (isModelsRoute(event)) {
      if (method !== 'GET') {
        throw Errors.validation(`Unsupported method: ${method}`);
      }
      return ok(await listGenericModels());
    }

    if (!aiProfileId) {
      if (method === 'GET') {
        return ok(await listAiProfiles(userId, event.queryStringParameters));
      }
      if (method === 'POST') {
        return created(
          await createPersonalProfile(userId, parseOptionalJsonBody(event)),
        );
      }
      throw Errors.validation(`Unsupported method: ${method}`);
    }

    if (method === 'GET') {
      return ok(toAiProfile(await getReadableAiProfile(userId, aiProfileId)));
    }

    if (method === 'DELETE') {
      await deletePersonalProfile(userId, aiProfileId);
      return noContent();
    }

    throw Errors.validation(`Unsupported method: ${method}`);
  } catch (error) {
    return errorResponse(error);
  }
}

function isModelsRoute(event: APIGatewayProxyEventV2): boolean {
  const key = routeKey(event);
  const path = event.rawPath ?? '';
  return (
    key.includes('/ai-profiles/models') ||
    path === '/ai-profiles/models' ||
    path.endsWith('/ai-profiles/models')
  );
}

async function listAiProfiles(
  userId: string,
  query: APIGatewayProxyEventV2['queryStringParameters'],
): Promise<AiProfileList> {
  const type = optionalAiProfileType(query?.type);
  if (type === 'GENERIC_MODEL') {
    return listGenericModels();
  }
  return listPersonalProfiles(userId);
}

async function listPersonalProfiles(userId: string): Promise<AiProfileList> {
  const items = await queryByPk(keys.userPk(userId), 'AIPROFILE#');
  return {
    aiProfiles: items
      .filter((item) => isPersonalAiProfile(item, userId))
      .map(toAiProfile),
  };
}

async function listGenericModels(): Promise<AiProfileList> {
  const fromGsi = await queryByGsi1(keys.gsi1GenericTypePk(), {
    skPrefix: 'AIPROFILE#',
  });
  const generic = fromGsi.filter(
    (item) => isAiProfileItem(item) && item.type === 'GENERIC_MODEL',
  );

  if (generic.length > 0) {
    return { aiProfiles: generic.map(toAiProfile) };
  }

  const catalog = await queryByPk(keys.genericModelPk(), 'AIPROFILE#');
  return {
    aiProfiles: catalog
      .filter((item) => isAiProfileItem(item) && item.type === 'GENERIC_MODEL')
      .map(toAiProfile),
  };
}

async function createPersonalProfile(
  userId: string,
  body: CreateAiProfileBody,
): Promise<AiProfile> {
  requireCreatePersonalType(body.type);
  const referenceImages = optionalReferenceImages(body.referenceImages, userId);
  const timestamp = nowIso();

  const item = buildPersonalAiProfile({
    userId,
    aiProfileId: newAiProfileId(),
    referenceImages,
    // Empty refs: nothing to process. WARDROBE-44 may flip to PENDING on upload.
    status: 'READY',
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  await putItem(item);
  return toAiProfile(item);
}

async function deletePersonalProfile(
  userId: string,
  aiProfileId: string,
): Promise<void> {
  try {
    await getOwnedPersonalAiProfile(userId, aiProfileId);
  } catch (error) {
    const generic = await findGenericAiProfile(aiProfileId);
    if (generic) {
      throw Errors.unauthorized('GENERIC_MODEL profiles cannot be deleted.');
    }
    throw error;
  }

  await deleteItem(keys.userPk(userId), keys.aiProfileSk(aiProfileId));
}
