import { getReadableAiProfile } from '../../shared/dynamodb';
import { Errors } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { createPresignedGetUrl } from '../../shared/s3';
import {
  DynamoItem,
  OutfitRender,
  OutfitRenderHistoryEntry,
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

/** Internal request id stored on Dynamo `render` — not part of the Flutter DTO. */
export function renderRequestId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.renderId !== 'string' || !raw.renderId.trim()) {
    return undefined;
  }
  return raw.renderId.trim();
}

export function toRenderHistory(value: unknown): OutfitRenderHistoryEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const entries: OutfitRenderHistoryEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const entry = toRenderHistoryEntry(raw);
    if (!entry || seen.has(entry.imageKey)) {
      continue;
    }
    seen.add(entry.imageKey);
    entries.push(entry);
  }
  return entries;
}

function toRenderHistoryEntry(
  value: unknown,
): OutfitRenderHistoryEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const imageKey =
    typeof raw.imageKey === 'string' ? raw.imageKey.trim() : '';
  const createdAt =
    typeof raw.createdAt === 'string' ? raw.createdAt.trim() : '';
  const aiProfileId =
    typeof raw.aiProfileId === 'string' ? raw.aiProfileId.trim() : '';
  if (!imageKey || !createdAt) {
    return undefined;
  }

  return { imageKey, createdAt, aiProfileId };
}

/** Append a successful try-on. Dedupes by imageKey so redeliveries stay append-only. */
export function appendSuccessfulRender(
  history: OutfitRenderHistoryEntry[],
  entry: OutfitRenderHistoryEntry,
): OutfitRenderHistoryEntry[] {
  if (history.some((existing) => existing.imageKey === entry.imageKey)) {
    return history;
  }
  return [...history, entry];
}

/**
 * Keep a previous READY try-on when `render` is about to be overwritten
 * (POST PENDING) or when a legacy row has no `renderHistory` yet.
 */
export function seedHistoryFromCurrentRender(
  history: OutfitRenderHistoryEntry[],
  render: OutfitRender | undefined,
  fallbackCreatedAt: string,
): OutfitRenderHistoryEntry[] {
  if (!render || render.status !== 'READY' || !render.imageKey) {
    return history;
  }
  return appendSuccessfulRender(history, {
    imageKey: render.imageKey,
    createdAt: fallbackCreatedAt,
    aiProfileId: render.aiProfileId,
  });
}

export function newestFirstHistory(
  history: OutfitRenderHistoryEntry[],
): OutfitRenderHistoryEntry[] {
  return [...history].reverse();
}

export async function signedRenderImageUrl(
  objectKey: string,
): Promise<string | undefined> {
  if (!objectKey.trim()) {
    return undefined;
  }

  try {
    const { imageUrl } = await createPresignedGetUrl({ objectKey });
    return imageUrl;
  } catch (error) {
    logger.warn('Failed to presign outfit render image GET URL', {
      objectKey,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return undefined;
  }
}

export async function withSignedRenderUrl(
  render: OutfitRender,
): Promise<OutfitRender> {
  if (render.status !== 'READY' || !render.imageKey) {
    return render;
  }

  const imageUrl = await signedRenderImageUrl(render.imageKey);
  return imageUrl ? { ...render, imageUrl } : render;
}

/**
 * Newest-first history plus the ordered URL list. A failed presign omits
 * that URL only — the rest of the outfit still returns.
 */
export async function withSignedRenderHistory(
  history: OutfitRenderHistoryEntry[],
): Promise<{
  renderHistory?: OutfitRenderHistoryEntry[];
  renderImageUrls?: string[];
}> {
  if (history.length === 0) {
    return {};
  }

  const signed: OutfitRenderHistoryEntry[] = [];
  const urls: string[] = [];
  for (const entry of newestFirstHistory(history)) {
    const imageUrl = await signedRenderImageUrl(entry.imageKey);
    signed.push(imageUrl ? { ...entry, imageUrl } : { ...entry });
    if (imageUrl) {
      urls.push(imageUrl);
    }
  }

  return {
    renderHistory: signed,
    ...(urls.length > 0 ? { renderImageUrls: urls } : {}),
  };
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

/** Prefer the original product photo for try-on; cutouts overlay too easily. */
export function clothingItemImageKey(item: DynamoItem): string | undefined {
  if (typeof item.originalKey === 'string' && item.originalKey.trim()) {
    return item.originalKey.trim();
  }
  if (typeof item.processedKey === 'string' && item.processedKey.trim()) {
    return item.processedKey.trim();
  }
  return undefined;
}

export function pendingRender(
  aiProfileId: string,
  renderId: string,
): OutfitRender & { renderId: string } {
  return {
    status: 'PENDING',
    aiProfileId,
    renderId,
  };
}
