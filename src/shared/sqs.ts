import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { AppError, Errors } from './errors';
import { logger } from './logger';
import {
  PROCESS_WARDROBE_ITEM_JOB,
  ProcessWardrobeItemJob,
  RENDER_OUTFIT_JOB,
  RenderOutfitJob,
} from './types';

function requiredJobField(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse an SQS body as PROCESS_WARDROBE_ITEM. Returns undefined for
 * poison payloads (invalid JSON, wrong job type, missing fields).
 */
export function parseProcessWardrobeItemJob(
  body: string,
): ProcessWardrobeItemJob | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }

  const raw = parsed as Record<string, unknown>;
  if (raw.jobType !== PROCESS_WARDROBE_ITEM_JOB) {
    return undefined;
  }

  const userId = requiredJobField(raw.userId);
  const wardrobeId = requiredJobField(raw.wardrobeId);
  const itemId = requiredJobField(raw.itemId);
  const originalImageKey = requiredJobField(raw.originalImageKey);

  if (!userId || !wardrobeId || !itemId || !originalImageKey) {
    return undefined;
  }

  return {
    jobType: PROCESS_WARDROBE_ITEM_JOB,
    userId,
    wardrobeId,
    itemId,
    originalImageKey,
  };
}

const sqs = new SQSClient({});

export function processingQueueUrl(): string {
  const url = process.env.PROCESSING_QUEUE_URL;
  if (!url) {
    throw Errors.internal('PROCESSING_QUEUE_URL is not configured.');
  }
  return url;
}

export async function enqueueProcessWardrobeItem(job: {
  userId: string;
  wardrobeId: string;
  itemId: string;
  originalImageKey: string;
}): Promise<void> {
  const message: ProcessWardrobeItemJob = {
    jobType: PROCESS_WARDROBE_ITEM_JOB,
    userId: job.userId,
    wardrobeId: job.wardrobeId,
    itemId: job.itemId,
    originalImageKey: job.originalImageKey,
  };

  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: processingQueueUrl(),
        MessageBody: JSON.stringify(message),
      }),
    );
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    logger.error('Failed to enqueue clothing-item processing job', {
      itemId: job.itemId,
      wardrobeId: job.wardrobeId,
    });
    throw Errors.internal('Failed to enqueue clothing-item processing job.');
  }
}

/**
 * Parse an SQS body as RENDER_OUTFIT. Returns undefined for poison
 * payloads (invalid JSON, wrong job type, missing fields).
 */
export function parseRenderOutfitJob(body: string): RenderOutfitJob | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }

  const raw = parsed as Record<string, unknown>;
  if (raw.jobType !== RENDER_OUTFIT_JOB) {
    return undefined;
  }

  const userId = requiredJobField(raw.userId);
  const wardrobeId = requiredJobField(raw.wardrobeId);
  const outfitId = requiredJobField(raw.outfitId);
  const aiProfileId = requiredJobField(raw.aiProfileId);

  if (!userId || !wardrobeId || !outfitId || !aiProfileId) {
    return undefined;
  }

  return {
    jobType: RENDER_OUTFIT_JOB,
    userId,
    wardrobeId,
    outfitId,
    aiProfileId,
  };
}

export function tryOnQueueUrl(): string {
  const url = process.env.TRY_ON_QUEUE_URL;
  if (!url) {
    throw Errors.internal('TRY_ON_QUEUE_URL is not configured.');
  }
  return url;
}

export async function enqueueRenderOutfit(job: {
  userId: string;
  wardrobeId: string;
  outfitId: string;
  aiProfileId: string;
}): Promise<void> {
  const message: RenderOutfitJob = {
    jobType: RENDER_OUTFIT_JOB,
    userId: job.userId,
    wardrobeId: job.wardrobeId,
    outfitId: job.outfitId,
    aiProfileId: job.aiProfileId,
  };

  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: tryOnQueueUrl(),
        MessageBody: JSON.stringify(message),
      }),
    );
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    logger.error('Failed to enqueue outfit render job', {
      outfitId: job.outfitId,
      wardrobeId: job.wardrobeId,
      aiProfileId: job.aiProfileId,
    });
    throw Errors.internal('Failed to enqueue outfit render job.');
  }
}
