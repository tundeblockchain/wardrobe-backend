import { keys } from '../../shared/dynamodb';
import { Errors } from '../../shared/errors';
import { newAiProfileId, nowIso } from '../../shared/ids';
import {
  AiProfile,
  AiProfileStatus,
  DynamoItem,
} from '../../shared/types';
import { MAX_AI_PROFILE_REFERENCE_IMAGES } from '../../shared/validation';

/** Owner written on seeded GENERIC_MODEL rows (WARDROBE-45). */
export const SYSTEM_AI_PROFILE_OWNER = 'SYSTEM';

export function toAiProfile(item: DynamoItem): AiProfile {
  const referenceImages = Array.isArray(item.referenceImages)
    ? item.referenceImages.map((entry) => String(entry))
    : [];

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
  const current = Array.isArray(existing)
    ? existing.map((entry) => String(entry))
    : [];
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
