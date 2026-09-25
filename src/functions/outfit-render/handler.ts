import { SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import {
  getItem,
  getReadableAiProfile,
  keys,
  updateAttributes,
} from '../../shared/dynamodb';
import { AppError } from '../../shared/errors';
import { newOutfitRenderId, nowIso } from '../../shared/ids';
import { logger } from '../../shared/logger';
import { parseRenderItemJob, parseRenderOutfitJob } from '../../shared/sqs';
import {
  AiProfileBodyContext,
  DynamoItem,
  OutfitItem,
  OutfitRender,
  OutfitRenderHistoryEntry,
  RenderItemJob,
  RenderOutfitJob,
  RenderStatus,
} from '../../shared/types';
import {
  isEmptyAiProfileBodyContext,
  pickAiProfileBodyContext,
} from '../ai-profiles/body-context';
import { normalizeReferenceImageKeys } from '../ai-profiles/model';
import { recordJobDone } from '../events/record';
import {
  isRetryableProcessingFailure,
  PermanentProcessingError,
  RetryableProcessingError,
} from '../processing/errors';
import {
  appendSuccessfulRender,
  clothingItemImageKey,
  renderRequestId,
  seedHistoryFromCurrentRender,
  toOutfitRender,
  toRenderHistory,
} from '../outfits/render';
import {
  garmentFromClothingItem,
  type OutfitTryOnGarment,
} from '../processing/outfit-context';
import { runItemTryOn, runOutfitTryOn } from '../processing/try-on';

/**
 * SQS worker for RENDER_OUTFIT (WARDROBE-47) and RENDER_ITEM (WARDROBE-150).
 *
 * Dedicated try-on queue — the clothing-item worker still only accepts
 * PROCESS_WARDROBE_ITEM and would treat this job as poison.
 *
 * DynamoDB is the source of truth. The SQS body is only a pointer;
 * owner, outfit/item, profile, and garment keys are re-checked on load.
 *
 * Status machine:
 *   PENDING → PROCESSING → READY
 *   *       → FAILED               (permanent / validation / Gemini errors)
 *
 * Retryable failures throw/report batch item failures so SQS redelivers.
 * After maxReceiveCount (3) the message lands on the DLQ. Poison messages
 * are acked so they do not cycle the retry budget.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (error) {
      if (isRetryableProcessingFailure(error)) {
        logger.error('Retryable outfit render failure', {
          messageId: record.messageId,
          error: error instanceof Error ? error.message : 'unknown',
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      logger.error('Non-retryable outfit render failure', {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  return { batchItemFailures };
}

async function processRecord(record: SQSRecord): Promise<void> {
  const outfitJob = parseRenderOutfitJob(record.body);
  if (outfitJob) {
    await processOutfitJob(outfitJob, record);
    return;
  }

  const itemJob = parseRenderItemJob(record.body);
  if (itemJob) {
    await processItemJob(itemJob, record);
    return;
  }

  logger.warn('Dropping poison outfit-render message', {
    messageId: record.messageId,
    receiveCount: record.attributes.ApproximateReceiveCount,
  });
}

async function processOutfitJob(
  job: RenderOutfitJob,
  record: SQSRecord,
): Promise<void> {
  logger.info('Processing outfit render job', {
    messageId: record.messageId,
    jobType: job.jobType,
    outfitId: job.outfitId,
    wardrobeId: job.wardrobeId,
    aiProfileId: job.aiProfileId,
    receiveCount: record.attributes.ApproximateReceiveCount,
  });

  const outfit = await loadOutfitForJob(job);
  if (!outfit) {
    return;
  }

  const current = outfitRender(outfit);
  const currentRenderId = renderRequestId(outfit.render);
  if (shouldSkipCompletedRender(current, currentRenderId, job)) {
    logger.info('Outfit render already READY; skipping try-on', {
      outfitId: job.outfitId,
      wardrobeId: job.wardrobeId,
      renderId: job.renderId,
    });
    await notifyRenderJobDone(job, 'READY', job.renderId ?? currentRenderId);
    return;
  }

  const renderId = job.renderId ?? newOutfitRenderId();
  const baselineHistory = seedHistoryFromCurrentRender(
    toRenderHistory(outfit.renderHistory),
    current,
    outfit.updatedAt,
  );

  const marked = await setRender(job, {
    status: 'PROCESSING',
    aiProfileId: job.aiProfileId,
    renderId,
  });
  if (!marked) {
    return;
  }

  try {
    const profile = await loadReadyProfile(job.userId, job.aiProfileId);
    const garments = await loadGarmentImages(job, outfit);
    const imageKey = await runOutfitTryOn({
      userId: job.userId,
      outfitId: job.outfitId,
      profileImageKeys: profile.referenceImages,
      garmentImages: garments,
      renderId,
      ...(isEmptyAiProfileBodyContext(profile.body)
        ? {}
        : { profileBody: profile.body }),
    });
    const renderHistory = appendSuccessfulRender(baselineHistory, {
      imageKey,
      createdAt: nowIso(),
      aiProfileId: job.aiProfileId,
    });
    await setRender(
      job,
      {
        status: 'READY',
        aiProfileId: job.aiProfileId,
        imageKey,
        renderId,
      },
      renderHistory,
    );
    await notifyRenderJobDone(job, 'READY', renderId);
    logger.info('Outfit render completed', {
      outfitId: job.outfitId,
      wardrobeId: job.wardrobeId,
      status: 'READY',
      imageKey,
      renderId,
      historyCount: renderHistory.length,
    });
  } catch (error) {
    if (error instanceof PermanentProcessingError) {
      logger.error('Permanent outfit render failure', {
        outfitId: job.outfitId,
        wardrobeId: job.wardrobeId,
        error: error.message,
      });
      const written = await setRender(job, {
        status: 'FAILED',
        aiProfileId: job.aiProfileId,
        error: error.message,
        renderId,
      });
      if (written) {
        await notifyRenderJobDone(job, 'FAILED', renderId, error.message);
      }
      return;
    }
    throw error instanceof RetryableProcessingError
      ? error
      : new RetryableProcessingError(
          error instanceof Error ? error.message : 'Outfit try-on failed',
          error,
        );
  }
}

async function processItemJob(
  job: RenderItemJob,
  record: SQSRecord,
): Promise<void> {
  logger.info('Processing item render job', {
    messageId: record.messageId,
    jobType: job.jobType,
    itemId: job.itemId,
    wardrobeId: job.wardrobeId,
    aiProfileId: job.aiProfileId,
    receiveCount: record.attributes.ApproximateReceiveCount,
  });

  const item = await loadItemForJob(job);
  if (!item) {
    return;
  }

  const current = outfitRender(item);
  const currentRenderId = renderRequestId(item.render);
  if (shouldSkipCompletedItemRender(current, currentRenderId, job)) {
    logger.info('Item render already READY; skipping try-on', {
      itemId: job.itemId,
      wardrobeId: job.wardrobeId,
      renderId: job.renderId,
    });
    await notifyItemRenderJobDone(job, 'READY', job.renderId ?? currentRenderId);
    return;
  }

  const renderId = job.renderId ?? newOutfitRenderId();
  const baselineHistory = seedHistoryFromCurrentRender(
    toRenderHistory(item.renderHistory),
    current,
    item.updatedAt,
  );

  const marked = await setItemRender(job, {
    status: 'PROCESSING',
    aiProfileId: job.aiProfileId,
    renderId,
  });
  if (!marked) {
    return;
  }

  try {
    const profile = await loadReadyProfile(job.userId, job.aiProfileId);
    const garments = await loadItemGarmentImages(job, item);
    const imageKey = await runItemTryOn({
      userId: job.userId,
      itemId: job.itemId,
      profileImageKeys: profile.referenceImages,
      garmentImages: garments,
      renderId,
      ...(isEmptyAiProfileBodyContext(profile.body)
        ? {}
        : { profileBody: profile.body }),
    });
    const renderHistory = appendSuccessfulRender(baselineHistory, {
      imageKey,
      createdAt: nowIso(),
      aiProfileId: job.aiProfileId,
    });
    await setItemRender(
      job,
      {
        status: 'READY',
        aiProfileId: job.aiProfileId,
        imageKey,
        renderId,
      },
      renderHistory,
    );
    await notifyItemRenderJobDone(job, 'READY', renderId);
    logger.info('Item render completed', {
      itemId: job.itemId,
      wardrobeId: job.wardrobeId,
      status: 'READY',
      imageKey,
      renderId,
      historyCount: renderHistory.length,
    });
  } catch (error) {
    if (error instanceof PermanentProcessingError) {
      logger.error('Permanent item render failure', {
        itemId: job.itemId,
        wardrobeId: job.wardrobeId,
        error: error.message,
      });
      const written = await setItemRender(job, {
        status: 'FAILED',
        aiProfileId: job.aiProfileId,
        error: error.message,
        renderId,
      });
      if (written) {
        await notifyItemRenderJobDone(job, 'FAILED', renderId, error.message);
      }
      return;
    }
    throw error instanceof RetryableProcessingError
      ? error
      : new RetryableProcessingError(
          error instanceof Error ? error.message : 'Item try-on failed',
          error,
        );
  }
}

async function loadItemForJob(
  job: RenderItemJob,
): Promise<DynamoItem | undefined> {
  let item: DynamoItem | undefined;
  try {
    item = await getItem(
      keys.wardrobePk(job.wardrobeId),
      keys.itemSk(job.itemId),
    );
  } catch (error) {
    if (!isRetryableProcessingFailure(error)) {
      logger.warn('Dropping job after non-retryable item load failure', {
        itemId: job.itemId,
        wardrobeId: job.wardrobeId,
        error: error instanceof Error ? error.message : 'unknown',
      });
      return undefined;
    }
    throw error instanceof RetryableProcessingError
      ? error
      : new RetryableProcessingError(
          error instanceof Error ? error.message : 'Failed to load item',
          error,
        );
  }

  if (!item) {
    logger.warn('Dropping job for missing item', {
      itemId: job.itemId,
      wardrobeId: job.wardrobeId,
    });
    return undefined;
  }

  if (
    item.entityType !== 'ITEM' ||
    item.userId !== job.userId ||
    item.wardrobeId !== job.wardrobeId ||
    item.itemId !== job.itemId
  ) {
    logger.warn('Dropping job that failed DynamoDB item ownership validation', {
      itemId: job.itemId,
      wardrobeId: job.wardrobeId,
    });
    return undefined;
  }

  return item;
}

async function loadItemGarmentImages(
  job: RenderItemJob,
  item: DynamoItem,
): Promise<OutfitTryOnGarment[]> {
  const objectKey = clothingItemImageKey(item) ?? '';
  if (!objectKey) {
    throw new PermanentProcessingError(
      `Clothing item ${job.itemId} has no image to render.`,
    );
  }

  const slot = typeof item.category === 'string' ? item.category : 'TOP';
  return [garmentFromClothingItem(item, slot, objectKey)];
}

function shouldSkipCompletedItemRender(
  current: OutfitRender | undefined,
  currentRenderId: string | undefined,
  job: RenderItemJob,
): boolean {
  if (current?.status !== 'READY') {
    return false;
  }
  if (job.renderId) {
    return currentRenderId === job.renderId;
  }
  return current.aiProfileId === job.aiProfileId;
}

async function setItemRender(
  job: RenderItemJob,
  render: {
    status: RenderStatus;
    aiProfileId: string;
    imageKey?: string;
    error?: string;
    renderId?: string;
  },
  renderHistory?: OutfitRenderHistoryEntry[],
): Promise<boolean> {
  try {
    await updateAttributes(
      keys.wardrobePk(job.wardrobeId),
      keys.itemSk(job.itemId),
      {
        render,
        updatedAt: nowIso(),
        ...(renderHistory ? { renderHistory } : {}),
      },
    );
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      logger.warn('Item disappeared while updating render status', {
        itemId: job.itemId,
        wardrobeId: job.wardrobeId,
        status: render.status,
      });
      return false;
    }
    throw error instanceof RetryableProcessingError
      ? error
      : new RetryableProcessingError(
          error instanceof Error
            ? error.message
            : 'Failed to update item render status',
          error,
        );
  }
}

async function notifyItemRenderJobDone(
  job: RenderItemJob,
  status: 'READY' | 'FAILED',
  renderId?: string,
  error?: string,
): Promise<void> {
  await recordJobDone({
    userId: job.userId,
    jobType: job.jobType,
    status,
    wardrobeId: job.wardrobeId,
    itemId: job.itemId,
    aiProfileId: job.aiProfileId,
    ...(renderId ? { renderId } : {}),
    ...(status === 'FAILED' && error ? { error } : {}),
  });
}

async function loadOutfitForJob(
  job: RenderOutfitJob,
): Promise<DynamoItem | undefined> {
  let item: DynamoItem | undefined;
  try {
    item = await getItem(
      keys.wardrobePk(job.wardrobeId),
      keys.outfitSk(job.outfitId),
    );
  } catch (error) {
    if (!isRetryableProcessingFailure(error)) {
      logger.warn('Dropping job after non-retryable outfit load failure', {
        outfitId: job.outfitId,
        wardrobeId: job.wardrobeId,
        error: error instanceof Error ? error.message : 'unknown',
      });
      return undefined;
    }
    throw error instanceof RetryableProcessingError
      ? error
      : new RetryableProcessingError(
          error instanceof Error ? error.message : 'Failed to load outfit',
          error,
        );
  }

  if (!item) {
    logger.warn('Dropping job for missing outfit', {
      outfitId: job.outfitId,
      wardrobeId: job.wardrobeId,
    });
    return undefined;
  }

  if (
    item.entityType !== 'OUTFIT' ||
    item.userId !== job.userId ||
    item.wardrobeId !== job.wardrobeId ||
    item.outfitId !== job.outfitId
  ) {
    logger.warn('Dropping job that failed DynamoDB ownership validation', {
      outfitId: job.outfitId,
      wardrobeId: job.wardrobeId,
    });
    return undefined;
  }

  return item;
}

async function loadReadyProfile(
  userId: string,
  aiProfileId: string,
): Promise<{ referenceImages: string[]; body: AiProfileBodyContext }> {
  let profile: DynamoItem;
  try {
    profile = await getReadableAiProfile(userId, aiProfileId);
  } catch (error) {
    if (error instanceof AppError) {
      throw new PermanentProcessingError(error.message);
    }
    if (isRetryableProcessingFailure(error)) {
      throw error instanceof RetryableProcessingError
        ? error
        : new RetryableProcessingError(
            error instanceof Error ? error.message : 'Failed to load Virtual Profile',
            error,
          );
    }
    throw new PermanentProcessingError(
      error instanceof Error ? error.message : 'Virtual Profile is not available.',
    );
  }

  if (profile.status !== 'READY') {
    throw new PermanentProcessingError(
      `Virtual Profile must be READY (current status: ${String(profile.status)}).`,
    );
  }

  const referenceImages = normalizeReferenceImageKeys(profile.referenceImages);
  if (referenceImages.length === 0) {
    throw new PermanentProcessingError('Virtual Profile has no reference images.');
  }

  return { referenceImages, body: pickAiProfileBodyContext(profile) };
}

async function loadGarmentImages(
  job: RenderOutfitJob,
  outfit: DynamoItem,
): Promise<OutfitTryOnGarment[]> {
  const items = toOutfitItems(outfit.items);
  if (items.length === 0) {
    throw new PermanentProcessingError('Outfit has no items to render.');
  }

  const garments: OutfitTryOnGarment[] = [];
  for (const { itemId, slot } of items) {
    let item: DynamoItem | undefined;
    try {
      item = await getItem(keys.wardrobePk(job.wardrobeId), keys.itemSk(itemId));
    } catch (error) {
      throw error instanceof RetryableProcessingError
        ? error
        : new RetryableProcessingError(
            error instanceof Error
              ? error.message
              : `Failed to load clothing item ${itemId}`,
            error,
          );
    }

    if (
      !item ||
      item.entityType !== 'ITEM' ||
      item.userId !== job.userId ||
      item.wardrobeId !== job.wardrobeId
    ) {
      throw new PermanentProcessingError(
        `Outfit item ${itemId} is not in this wardrobe.`,
      );
    }

    const objectKey = clothingItemImageKey(item) ?? '';
    if (!objectKey) {
      throw new PermanentProcessingError(
        `Clothing item ${itemId} has no image to render.`,
      );
    }

    garments.push(garmentFromClothingItem(item, slot, objectKey));
  }

  return garments;
}

function outfitRender(item: DynamoItem): OutfitRender | undefined {
  return toOutfitRender(item.render);
}

function shouldSkipCompletedRender(
  current: OutfitRender | undefined,
  currentRenderId: string | undefined,
  job: RenderOutfitJob,
): boolean {
  if (current?.status !== 'READY') {
    return false;
  }
  if (job.renderId) {
    return currentRenderId === job.renderId;
  }
  return current.aiProfileId === job.aiProfileId;
}

function toOutfitItems(value: unknown): OutfitItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      const raw = (entry ?? {}) as { itemId?: unknown; slot?: unknown };
      return {
        itemId: String(raw.itemId ?? '').trim(),
        slot: String(raw.slot ?? '').trim() as OutfitItem['slot'],
      };
    })
    .filter((entry) => entry.itemId);
}

async function setRender(
  job: RenderOutfitJob,
  render: {
    status: RenderStatus;
    aiProfileId: string;
    imageKey?: string;
    error?: string;
    renderId?: string;
  },
  renderHistory?: OutfitRenderHistoryEntry[],
): Promise<boolean> {
  try {
    await updateAttributes(
      keys.wardrobePk(job.wardrobeId),
      keys.outfitSk(job.outfitId),
      {
        render,
        updatedAt: nowIso(),
        ...(renderHistory ? { renderHistory } : {}),
      },
    );
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      logger.warn('Outfit disappeared while updating render status', {
        outfitId: job.outfitId,
        wardrobeId: job.wardrobeId,
        status: render.status,
      });
      return false;
    }
    throw error instanceof RetryableProcessingError
      ? error
      : new RetryableProcessingError(
          error instanceof Error
            ? error.message
            : 'Failed to update outfit render status',
          error,
        );
  }
}

async function notifyRenderJobDone(
  job: RenderOutfitJob,
  status: 'READY' | 'FAILED',
  renderId?: string,
  error?: string,
): Promise<void> {
  await recordJobDone({
    userId: job.userId,
    jobType: job.jobType,
    status,
    wardrobeId: job.wardrobeId,
    outfitId: job.outfitId,
    aiProfileId: job.aiProfileId,
    ...(renderId ? { renderId } : {}),
    ...(status === 'FAILED' && error ? { error } : {}),
  });
}
