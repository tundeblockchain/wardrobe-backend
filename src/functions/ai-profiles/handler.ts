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
  deleteObjectBestEffort,
  deleteObjectsUnderAiProfilePrefix,
  extensionForContentType,
  normalizeContentType,
} from '../../shared/s3';
import { AiProfile, AiProfileList } from '../../shared/types';
import {
  hasAiProfileBodyWrite,
  hasAiProfileDisplayWrite,
  optionalAiProfileType,
  optionalBoolean,
  optionalInteger,
  optionalNonEmptyString,
  optionalReferenceImages,
  parseAiProfileBodyContext,
  parseAiProfileDisplayFields,
  requireAttachReferenceImageKeys,
  requireCreatePersonalType,
  requireExistingReferenceImageKey,
  requireNonEmptyString,
  type AttachReferenceImagesBody,
  type DeleteReferenceImageBody,
  type SetMainReferenceImageBody,
} from '../../shared/validation';
import {
  statusAfterReferenceImagesAttached,
} from './hooks';
import {
  buildPersonalAiProfile,
  mergeReferenceImages,
  normalizeReferenceImageKeys,
  personalMainImageWrite,
  resolveMainImageKey,
  toAiProfileDto,
} from './model';

interface CreateAiProfileBody {
  type?: unknown;
  referenceImages?: unknown;
  userId?: unknown;
  status?: unknown;
  label?: unknown;
  notes?: unknown;
  heightCm?: unknown;
  weightKg?: unknown;
  bustCm?: unknown;
  hipsCm?: unknown;
  clothingSize?: unknown;
  braSize?: unknown;
  ageYears?: unknown;
  bodyType?: unknown;
  gender?: unknown;
}

type UpdateAiProfileBody = CreateAiProfileBody;

interface CreateReferenceUploadBody {
  contentType?: unknown;
  purpose?: unknown;
  contentLength?: unknown;
  userId?: unknown;
}

/**
 * Authenticated Virtual Profile CRUD + PERSONAL reference-image upload
 * (WARDROBE-43/44) + frontal GET URLs on create/get/list (WARDROBE-73 /
 * WARDROBE-79) + optional body/context fields (WARDROBE-80 / WARDROBE-82)
 * + explicit main photo on PERSONAL galleries (WARDROBE-157)
 * + optional PERSONAL display name / notes (WARDROBE-158).
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

    if (isReferenceImagesMainRoute(event)) {
      if (method !== 'PATCH') {
        throw Errors.validation(`Unsupported method: ${method}`);
      }
      if (!aiProfileId) {
        throw Errors.validation('aiProfileId is required.');
      }
      return ok(
        await setMainReferenceImage(userId, aiProfileId, parseJsonBody(event)),
      );
    }

    if (isReferenceImagesRoute(event)) {
      if (!aiProfileId) {
        throw Errors.validation('aiProfileId is required.');
      }
      if (method === 'POST') {
        return ok(
          await attachReferenceImages(userId, aiProfileId, parseJsonBody(event)),
        );
      }
      if (method === 'DELETE') {
        return ok(
          await deleteReferenceImage(userId, aiProfileId, parseJsonBody(event)),
        );
      }
      throw Errors.validation(`Unsupported method: ${method}`);
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
      return ok(
        await toAiProfileDto(await getReadableAiProfile(userId, aiProfileId)),
      );
    }

    if (method === 'PATCH') {
      return ok(
        await updatePersonalProfile(
          userId,
          aiProfileId,
          parseJsonBody(event),
        ),
      );
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

function isReferenceImagesMainRoute(event: APIGatewayProxyEventV2): boolean {
  const key = routeKey(event);
  const path = event.rawPath ?? '';
  return (
    key.includes('/ai-profiles/{aiProfileId}/reference-images/main') ||
    (key.includes('/reference-images/main') && key.includes('/ai-profiles/')) ||
    /\/ai-profiles\/[^/]+\/reference-images\/main\/?$/.test(path)
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
    aiProfiles: await Promise.all(
      items
        .filter((item) => isPersonalAiProfile(item, userId))
        .map(toAiProfileDto),
    ),
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
    return {
      aiProfiles: await Promise.all(generic.map(toAiProfileDto)),
    };
  }

  const catalog = await queryByPk(keys.genericModelPk(), 'AIPROFILE#');
  return {
    aiProfiles: await Promise.all(
      catalog
        .filter((item) => isAiProfileItem(item) && item.type === 'GENERIC_MODEL')
        .map(toAiProfileDto),
    ),
  };
}

async function createPersonalProfile(
  userId: string,
  body: CreateAiProfileBody,
): Promise<AiProfile> {
  requireCreatePersonalType(body.type);
  const referenceImages = optionalReferenceImages(body.referenceImages, userId);
  const { set: bodyContext } = parseAiProfileBodyContext(
    body as Record<string, unknown>,
  );
  const { set: display } = parseAiProfileDisplayFields(
    body as Record<string, unknown>,
  );
  const timestamp = nowIso();

  const item = buildPersonalAiProfile({
    userId,
    aiProfileId: newAiProfileId(),
    referenceImages,
    body: bodyContext,
    label: display.label,
    notes: display.notes,
    // Empty refs: nothing to process. Attach (WARDROBE-44) keeps READY.
    status: 'READY',
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  await putItem(item);
  return toAiProfileDto(item);
}

async function updatePersonalProfile(
  userId: string,
  aiProfileId: string,
  body: UpdateAiProfileBody,
): Promise<AiProfile> {
  const profile = await requireOwnedPersonalForMutation(
    userId,
    aiProfileId,
    'GENERIC_MODEL profiles cannot be updated.',
  );

  const write = parseAiProfileBodyContext(body as Record<string, unknown>, {
    allowClear: true,
  });
  const display = parseAiProfileDisplayFields(body as Record<string, unknown>, {
    allowClear: true,
  });
  if (!hasAiProfileBodyWrite(write) && !hasAiProfileDisplayWrite(display)) {
    throw Errors.validation(
      'At least one body context, label, or notes field is required.',
    );
  }

  const mainAttributes = mainImageUpdate(
    profile.referenceImages,
    profile.mainImageKey,
  );
  const remove = [...write.remove, ...display.remove, ...mainAttributes.remove];

  const updated = await updateAttributes(
    keys.userPk(userId),
    keys.aiProfileSk(aiProfileId),
    {
      ...write.set,
      ...display.set,
      updatedAt: nowIso(),
      ...mainAttributes.set,
    },
    remove.length > 0 ? { remove } : undefined,
  );

  return toAiProfileDto(updated);
}

function mainImageUpdate(
  referenceImages: unknown,
  storedMain?: unknown,
): { set: Record<string, string>; remove: string[] } {
  const write = personalMainImageWrite(referenceImages, storedMain);
  if (write.remove) {
    return { set: {}, remove: ['mainImageKey'] };
  }
  return {
    set: write.set ? { mainImageKey: write.set } : {},
    remove: [],
  };
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
  await deleteObjectsUnderAiProfilePrefix(userId, aiProfileId);
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
  const existing = normalizeReferenceImageKeys(profile.referenceImages);
  const setAsMain =
    optionalBoolean(body.setAsMain, 'setAsMain') ?? existing.length === 0;
  const replaceMain = optionalBoolean(body.replaceMain, 'replaceMain') ?? false;

  if (replaceMain && !setAsMain) {
    throw Errors.validation('replaceMain requires setAsMain to be true.');
  }

  const previousMain = resolveMainImageKey(existing, profile.mainImageKey);
  const replacingPreviousMain =
    replaceMain &&
    Boolean(previousMain) &&
    previousMain !== undefined &&
    !incoming.includes(previousMain);
  const base = replacingPreviousMain
    ? existing.filter((key) => key !== previousMain)
    : existing;
  const referenceImages = mergeReferenceImages(base, incoming);
  const preferredMain = setAsMain ? incoming[0] : previousMain;
  const mainAttributes = mainImageUpdate(referenceImages, preferredMain);
  const status = statusAfterReferenceImagesAttached();
  const updatedAt = nowIso();

  const updated = await updateAttributes(
    keys.userPk(userId),
    keys.aiProfileSk(aiProfileId),
    {
      referenceImages,
      status,
      updatedAt,
      ...mainAttributes.set,
    },
    mainAttributes.remove.length > 0
      ? { remove: mainAttributes.remove }
      : undefined,
  );

  const nextMain = resolveMainImageKey(
    referenceImages,
    updated.mainImageKey ?? preferredMain,
  );
  if (
    replaceMain &&
    previousMain &&
    nextMain &&
    previousMain !== nextMain
  ) {
    await deleteObjectBestEffort(previousMain);
  }

  return toAiProfileDto(updated);
}

async function setMainReferenceImage(
  userId: string,
  aiProfileId: string,
  body: SetMainReferenceImageBody,
): Promise<AiProfile> {
  const profile = await requireOwnedPersonalForMutation(
    userId,
    aiProfileId,
    'GENERIC_MODEL profiles do not accept reference image updates.',
  );

  const referenceImages = normalizeReferenceImageKeys(profile.referenceImages);
  const objectKey = requireExistingReferenceImageKey(
    body.objectKey,
    referenceImages,
  );
  const mainAttributes = mainImageUpdate(referenceImages, objectKey);

  const updated = await updateAttributes(
    keys.userPk(userId),
    keys.aiProfileSk(aiProfileId),
    {
      updatedAt: nowIso(),
      ...mainAttributes.set,
    },
    mainAttributes.remove.length > 0
      ? { remove: mainAttributes.remove }
      : undefined,
  );

  return toAiProfileDto(updated);
}

async function deleteReferenceImage(
  userId: string,
  aiProfileId: string,
  body: DeleteReferenceImageBody,
): Promise<AiProfile> {
  const profile = await requireOwnedPersonalForMutation(
    userId,
    aiProfileId,
    'GENERIC_MODEL profiles do not accept reference image updates.',
  );

  const existing = normalizeReferenceImageKeys(profile.referenceImages);
  const objectKey = requireExistingReferenceImageKey(
    body.objectKey,
    existing,
  );
  const remaining = existing.filter((key) => key !== objectKey);
  const currentMain = resolveMainImageKey(existing, profile.mainImageKey);
  const deletingMain = currentMain === objectKey;

  let preferredMain: string | undefined;
  if (!deletingMain) {
    preferredMain = currentMain;
  } else if (remaining.length === 0) {
    preferredMain = undefined;
  } else if (remaining.length === 1) {
    preferredMain = remaining[0];
  } else {
    const promote = optionalNonEmptyString(
      body.promoteObjectKey,
      'promoteObjectKey',
      1024,
    );
    if (!promote) {
      throw Errors.mainImageRequired();
    }
    if (!remaining.includes(promote)) {
      throw Errors.validation(
        'promoteObjectKey must be another remaining reference image.',
      );
    }
    preferredMain = promote;
  }

  const mainAttributes = mainImageUpdate(remaining, preferredMain);
  const updated = await updateAttributes(
    keys.userPk(userId),
    keys.aiProfileSk(aiProfileId),
    {
      referenceImages: remaining,
      updatedAt: nowIso(),
      ...mainAttributes.set,
    },
    mainAttributes.remove.length > 0
      ? { remove: mainAttributes.remove }
      : undefined,
  );

  await deleteObjectBestEffort(objectKey);
  return toAiProfileDto(updated);
}
