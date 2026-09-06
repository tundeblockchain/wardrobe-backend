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
  updateAttributes,
} from '../../shared/dynamodb';
import { Errors } from '../../shared/errors';
import {
  created,
  errorResponse,
  noContent,
  ok,
  parseJsonBody,
  parseOptionalJsonBody,
  routeKey,
} from '../../shared/http';
import { newAiProfileId, newUploadId, nowIso } from '../../shared/ids';
import {
  aiProfileReferencePrefix,
  assertUploadContentLength,
  createPresignedPutUrl,
  extensionForContentType,
  normalizeContentType,
} from '../../shared/s3';
import { AiProfile, AiProfileList } from '../../shared/types';
import {
  optionalAiProfileType,
  optionalInteger,
  optionalNonEmptyString,
  optionalReferenceImages,
  requireAttachReferenceImageKeys,
  requireCreatePersonalType,
  requireNonEmptyString,
} from '../../shared/validation';
import {
  statusAfterReferenceImagesAttached,
} from './hooks';
import {
  buildPersonalAiProfile,
  mergeReferenceImages,
  toAiProfile,
} from './model';

interface CreateAiProfileBody {
  type?: unknown;
  referenceImages?: unknown;
  userId?: unknown;
  status?: unknown;
}

interface CreateReferenceUploadBody {
  contentType?: unknown;
  purpose?: unknown;
  contentLength?: unknown;
  userId?: unknown;
}

interface AttachReferenceImagesBody {
  objectKey?: unknown;
  objectKeys?: unknown;
  userId?: unknown;
}

/**
 * Authenticated AI Profile CRUD + PERSONAL reference-image upload (WARDROBE-43/44).
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

    if (isUploadsRoute(event)) {
      if (method !== 'POST') {
        throw Errors.validation(`Unsupported method: ${method}`);
      }
      if (!aiProfileId) {
        throw Errors.validation('aiProfileId is required.');
      }
      return created(
        await createReferenceImageUpload(
          userId,
          aiProfileId,
          parseJsonBody(event),
        ),
      );
    }

    if (isReferenceImagesRoute(event)) {
      if (method !== 'POST') {
        throw Errors.validation(`Unsupported method: ${method}`);
      }
      if (!aiProfileId) {
        throw Errors.validation('aiProfileId is required.');
      }
      return ok(
        await attachReferenceImages(userId, aiProfileId, parseJsonBody(event)),
      );
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

function isUploadsRoute(event: APIGatewayProxyEventV2): boolean {
  const key = routeKey(event);
  const path = event.rawPath ?? '';
  return (
    key.includes('/ai-profiles/{aiProfileId}/uploads') ||
    (key.includes('/uploads') && key.includes('/ai-profiles/')) ||
    /\/ai-profiles\/[^/]+\/uploads\/?$/.test(path)
  );
}

function isReferenceImagesRoute(event: APIGatewayProxyEventV2): boolean {
  const key = routeKey(event);
  const path = event.rawPath ?? '';
  return (
    key.includes('/ai-profiles/{aiProfileId}/reference-images') ||
    (key.includes('/reference-images') && key.includes('/ai-profiles/')) ||
    /\/ai-profiles\/[^/]+\/reference-images\/?$/.test(path)
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
    // Empty refs: nothing to process. Attach (WARDROBE-44) keeps READY.
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

async function requireOwnedPersonalForMutation(
  userId: string,
  aiProfileId: string,
  genericMessage: string,
) {
  try {
    return await getOwnedPersonalAiProfile(userId, aiProfileId);
  } catch (error) {
    const generic = await findGenericAiProfile(aiProfileId);
    if (generic) {
      throw Errors.unauthorized(genericMessage);
    }
    throw error;
  }
}

async function createReferenceImageUpload(
  userId: string,
  aiProfileId: string,
  body: CreateReferenceUploadBody,
) {
  await requireOwnedPersonalForMutation(
    userId,
    aiProfileId,
    'GENERIC_MODEL profiles do not accept reference image uploads.',
  );

  const contentType = normalizeContentType(
    requireNonEmptyString(body.contentType, 'contentType', 64),
  );
  const purpose = optionalNonEmptyString(body.purpose, 'purpose', 64);
  if (purpose !== undefined && purpose !== 'AI_PROFILE_REFERENCE') {
    throw Errors.uploadInvalid('purpose must be AI_PROFILE_REFERENCE.');
  }

  const declaredLength = optionalInteger(body.contentLength, 'contentLength');
  const contentLength =
    declaredLength === undefined
      ? undefined
      : assertUploadContentLength(declaredLength);

  const extension = extensionForContentType(contentType);
  const objectKey = `${aiProfileReferencePrefix(userId, aiProfileId)}${newUploadId()}.${extension}`;
  const { uploadUrl, expiresIn } = await createPresignedPutUrl({
    objectKey,
    contentType,
    contentLength,
  });

  return {
    uploadUrl,
    objectKey,
    expiresIn,
  };
}

async function attachReferenceImages(
  userId: string,
  aiProfileId: string,
  body: AttachReferenceImagesBody,
): Promise<AiProfile> {
  const profile = await requireOwnedPersonalForMutation(
    userId,
    aiProfileId,
    'GENERIC_MODEL profiles do not accept reference image uploads.',
  );

  const incoming = requireAttachReferenceImageKeys(body, userId, aiProfileId);
  const referenceImages = mergeReferenceImages(
    profile.referenceImages,
    incoming,
  );
  const status = statusAfterReferenceImagesAttached();
  const updatedAt = nowIso();

  const updated = await updateAttributes(
    keys.userPk(userId),
    keys.aiProfileSk(aiProfileId),
    {
      referenceImages,
      status,
      updatedAt,
    },
  );

  return toAiProfile(updated);
}
