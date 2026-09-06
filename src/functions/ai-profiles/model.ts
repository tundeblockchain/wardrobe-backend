import { keys } from '../../shared/dynamodb';
import { newAiProfileId, nowIso } from '../../shared/ids';
import {
  AiProfile,
  AiProfileStatus,
  DynamoItem,
} from '../../shared/types';

/** Owner written on seeded GENERIC_MODEL rows (WARDROBE-45). */
export const SYSTEM_AI_PROFILE_OWNER = 'SYSTEM';

export function toAiProfile(item: DynamoItem): AiProfile {
  const referenceImages = Array.isArray(item.referenceImages)
    ? item.referenceImages.map((entry) => String(entry))
    : [];

  return {
    aiProfileId: String(item.aiProfileId),
    type: item.type === 'GENERIC_MODEL' ? 'GENERIC_MODEL' : 'PERSONAL',
    referenceImages,
    status: normalizeStatus(item.status),
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
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
} = {}): DynamoItem {
  const aiProfileId = input.aiProfileId ?? newAiProfileId();
  const timestamp = input.createdAt ?? nowIso();

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
  };
}
