import { getReadableAiProfile } from '../../shared/dynamodb';
import { Errors } from '../../shared/errors';
import { createPresignedGetUrl } from '../../shared/s3';
import {
  DynamoItem,
  OutfitRender,
  RENDER_STATUSES,
  RenderStatus,
} from '../../shared/types';

export function toOutfitRender(value: unknown): OutfitRender | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  if (!isRenderStatus(raw.status)) {
    return undefined;
  }

  const aiProfileId =
    typeof raw.aiProfileId === 'string' ? raw.aiProfileId.trim() : '';
  const render: OutfitRender = {
    status: raw.status,
    aiProfileId,
  };

  if (typeof raw.imageKey === 'string' && raw.imageKey.trim()) {
    render.imageKey = raw.imageKey.trim();
  }
  if (typeof raw.error === 'string' && raw.error.trim()) {
    render.error = raw.error.trim();
  }

  return render;
}

function isRenderStatus(value: unknown): value is RenderStatus {
  return (RENDER_STATUSES as readonly string[]).includes(String(value));
}

export async function withSignedRenderUrl(
  render: OutfitRender,
): Promise<OutfitRender> {
  if (render.status !== 'READY' || !render.imageKey) {
    return render;
  }

  try {
    const { imageUrl } = await createPresignedGetUrl({
      objectKey: render.imageKey,
    });
    return { ...render, imageUrl };
  } catch {
    return render;
  }
}

export function profileReferenceImages(profile: DynamoItem): string[] {
  if (!Array.isArray(profile.referenceImages)) {
    return [];
  }
  return profile.referenceImages
    .map((entry) => String(entry).trim())
    .filter(Boolean);
}

/**
 * Owner PERSONAL or shared GENERIC_MODEL. Must be READY with at least
 * one reference image. Identity is the Firebase UID — never a body userId.
 */
export async function requireReadyRenderableProfile(
  userId: string,
  aiProfileId: string,
): Promise<DynamoItem> {
  const profile = await getReadableAiProfile(userId, aiProfileId);
  if (profile.status !== 'READY') {
    throw Errors.validation(
      `AI profile must be READY before requesting a try-on (current status: ${String(profile.status)}).`,
    );
  }
  if (profileReferenceImages(profile).length === 0) {
    throw Errors.validation('AI profile has no reference images.');
  }
  return profile;
}

export function clothingItemImageKey(item: DynamoItem): string | undefined {
  if (typeof item.processedKey === 'string' && item.processedKey.trim()) {
    return item.processedKey.trim();
  }
  if (typeof item.originalKey === 'string' && item.originalKey.trim()) {
    return item.originalKey.trim();
  }
  return undefined;
}

export function pendingRender(aiProfileId: string): OutfitRender {
  return {
    status: 'PENDING',
    aiProfileId,
  };
}
