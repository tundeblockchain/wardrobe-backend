import { keys } from '../../shared/dynamodb';
import { Errors } from '../../shared/errors';
import { newAiProfileId, nowIso } from '../../shared/ids';
import { logger } from '../../shared/logger';
import { createPresignedGetUrl } from '../../shared/s3';
import {
  AiProfile,
  AiProfileStatus,
  DynamoItem,
} from '../../shared/types';
import { MAX_AI_PROFILE_REFERENCE_IMAGES } from '../../shared/validation';

/** Owner written on seeded GENERIC_MODEL rows (WARDROBE-45). */
export const SYSTEM_AI_PROFILE_OWNER = 'SYSTEM';

/**
 * Coerce Dynamo `referenceImages` into S3 object keys.
 *
 * GENERIC_MODEL catalog rows are written as a JS string[] (Dynamo List) with
 * `shared/.../front.png`, so WARDROBE-73 already produced `frontImageUrl`.
 * PERSONAL attach writes a JS string[] as well, but Document Client
 * unmarshalls a Dynamo String Set (SS) as a native `Set`, and some rows
 * store `{ objectKey }` maps. `Array.isArray` is false for a Set, so
 * `toAiProfile` used to drop every personal key and omit `frontImageUrl`
 * (WARDROBE-79).
 */
export function normalizeReferenceImageKeys(value: unknown): string[] {
  const objectKeys: string[] = [];
  const seen = new Set<string>();

  for (const entry of iterateReferenceImageEntries(value)) {
    const objectKey = objectKeyFromReferenceEntry(entry);
    if (!objectKey || seen.has(objectKey)) {
      continue;
    }
    seen.add(objectKey);
    objectKeys.push(objectKey);
  }

  return objectKeys;
}

function iterateReferenceImageEntries(value: unknown): unknown[] {
  if (value == null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (value instanceof Set) {
    return [...value];
  }
  if (typeof value === 'string') {
    return [value];
  }
  if (typeof value === 'object') {
    return [value];
  }
  return [];
}

function objectKeyFromReferenceEntry(entry: unknown): string | undefined {
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    return trimmed ? trimmed : undefined;
  }
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }

  const record = entry as Record<string, unknown>;
  const wrapped =
    record.objectKey ??
    record.key ??
    record.imageKey ??
    record.S ??
    record.s;
  if (typeof wrapped === 'string' && wrapped.trim()) {
    return wrapped.trim();
  }

  return undefined;
}

export function toAiProfile(item: DynamoItem): AiProfile {
  const referenceImages = normalizeReferenceImageKeys(item.referenceImages);

  const label =
    typeof item.label === 'string' && item.label.trim()
      ? item.label.trim()
      : undefined;

  return {
    aiProfileId: String(item.aiProfileId),
    type: item.type === 'GENERIC_MODEL' ? 'GENERIC_MODEL' : 'PERSONAL',
    referenceImages,
    status: normalizeStatus(item.status),
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
    ...(label ? { label } : {}),
  };
}

/** Filename of an S3 object key (`front.png` from `…/alex/front.png`). */
function objectKeyFileName(objectKey: string): string {
  const segments = objectKey.split('/');
  return segments[segments.length - 1] ?? '';
}

/**
 * Frontal key for WARDROBE-73 / Flutter WARDROBE-71.
 * Prefer a `referenceImages` entry whose filename starts with `front.`
 * (seeded GENERIC_MODEL `front.png`). Otherwise the first key.
 */
export function frontalReferenceImageKey(
  referenceImages: string[],
): string | undefined {
  const objectKeys = referenceImages
    .map((entry) => entry.trim())
    .filter(Boolean);
  const namedFront = objectKeys.find((key) =>
    /^front\./i.test(objectKeyFileName(key)),
  );
  return namedFront ?? objectKeys[0];
}

/**
 * WARDROBE-73 / WARDROBE-79: Flutter reads top-level HTTPS URLs. Soft-fail
 * so a presign error cannot 500 list / get / create / attach.
 */
export async function toAiProfileDto(item: DynamoItem): Promise<AiProfile> {
  return withSignedReferenceImageUrls(toAiProfile(item));
}

export async function withSignedReferenceImageUrls(
  profile: AiProfile,
): Promise<AiProfile> {
  const signed = new Map<string, string>();

  for (const objectKey of profile.referenceImages) {
    const imageUrl = await signedReferenceImageUrl(objectKey);
    if (imageUrl) {
      signed.set(objectKey, imageUrl);
    }
  }

  const frontKey = frontalReferenceImageKey(profile.referenceImages);
  const frontImageUrl = frontKey ? signed.get(frontKey) : undefined;
  const extraUrls = Object.fromEntries(
    [...signed.entries()].filter(([key]) => key !== frontKey),
  );

  return {
    ...profile,
    ...(frontImageUrl ? { frontImageUrl } : {}),
    ...(Object.keys(extraUrls).length > 0
      ? { referenceImageUrls: extraUrls }
      : {}),
  };
}

async function signedReferenceImageUrl(
  objectKey: string,
): Promise<string | undefined> {
  if (!objectKey.trim()) {
    return undefined;
  }

  try {
    const { imageUrl } = await createPresignedGetUrl({ objectKey });
    return imageUrl;
  } catch (error) {
    logger.warn('Failed to presign AI profile reference image GET URL', {
      objectKey,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return undefined;
  }
}

function normalizeStatus(value: unknown): AiProfile['status'] {
  if (
    value === 'PENDING' ||
    value === 'PROCESSING' ||
    value === 'READY' ||
    value === 'FAILED'
  ) {
    return value;
  }
  return 'READY';
}

export function buildPersonalAiProfile(input: {
  userId: string;
  aiProfileId?: string;
  referenceImages?: string[];
  status?: AiProfileStatus;
  createdAt?: string;
  updatedAt?: string;
}): DynamoItem {
  const aiProfileId = input.aiProfileId ?? newAiProfileId();
  const timestamp = input.createdAt ?? nowIso();

  return {
    PK: keys.userPk(input.userId),
    SK: keys.aiProfileSk(aiProfileId),
    entityType: 'AIPROFILE',
    userId: input.userId,
    aiProfileId,
    type: 'PERSONAL',
    referenceImages: input.referenceImages ?? [],
    status: input.status ?? 'READY',
    createdAt: timestamp,
    updatedAt: input.updatedAt ?? timestamp,
  };
}

/** Append unique confirmed keys. Existing order is preserved. */
export function mergeReferenceImages(
  existing: unknown,
  incoming: string[],
): string[] {
  const current = normalizeReferenceImageKeys(existing);
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const key of [...current, ...incoming]) {
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(key);
    }
  }

  if (merged.length > MAX_AI_PROFILE_REFERENCE_IMAGES) {
    throw Errors.validation(
      `referenceImages must contain ${MAX_AI_PROFILE_REFERENCE_IMAGES} items or fewer.`,
    );
  }

  return merged;
}

/**
 * WARDROBE-45 seed helper. Writes the catalog PK plus sparse GSI1 keys
 * so `GET /ai-profiles/models` can list every generic model.
 */
export function buildGenericModelProfile(input: {
  aiProfileId?: string;
  referenceImages?: string[];
  status?: AiProfileStatus;
  userId?: string;
  createdAt?: string;
  updatedAt?: string;
  label?: string;
} = {}): DynamoItem {
  const aiProfileId = input.aiProfileId ?? newAiProfileId();
  const timestamp = input.createdAt ?? nowIso();
  const label = input.label?.trim();

  return {
    PK: keys.genericModelPk(),
    SK: keys.aiProfileSk(aiProfileId),
    GSI1PK: keys.gsi1GenericTypePk(),
    GSI1SK: keys.gsi1AiProfileSk(aiProfileId),
    entityType: 'AIPROFILE',
    userId: input.userId ?? SYSTEM_AI_PROFILE_OWNER,
    aiProfileId,
    type: 'GENERIC_MODEL',
    referenceImages: input.referenceImages ?? [],
    status: input.status ?? 'READY',
    createdAt: timestamp,
    updatedAt: input.updatedAt ?? timestamp,
    ...(label ? { label } : {}),
  };
}
