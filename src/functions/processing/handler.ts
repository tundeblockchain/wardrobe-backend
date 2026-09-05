import { SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { getItem, keys, updateAttributes } from '../../shared/dynamodb';
import { nowIso } from '../../shared/ids';
import { logger } from '../../shared/logger';
import { parseProcessWardrobeItemJob } from '../../shared/sqs';
import { DynamoItem, ProcessingStatus, ProcessWardrobeItemJob } from '../../shared/types';
import {
  isRetryableProcessingFailure,
  PermanentProcessingError,
  RetryableProcessingError,
} from './errors';
import { runProcessingPipeline } from './pipeline';

/**
 * SQS worker for PROCESS_WARDROBE_ITEM.
 *
 * DynamoDB is the source of truth. The SQS body is only a pointer;
 * owner, wardrobe, item, and originalImageKey are re-checked on load.
 *
 * Status machine (WARDROBE-17):
 *   PENDING → PROCESSING → READY   (stub pipeline success)
 *   *       → FAILED               (permanent / validation errors)
 *
 * Retryable failures throw/report batch item failures so SQS redelivers.
 * After maxReceiveCount (3) the message lands on the DLQ (WARDROBE-15).
 * Poison messages are acked so they do not cycle the retry budget.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (error) {
      if (isRetryableProcessingFailure(error)) {
        logger.error('Retryable clothing-item processing failure', {
          messageId: record.messageId,
          error: error instanceof Error ? error.message : 'unknown',
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      logger.error('Non-retryable clothing-item processing failure', {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  return { batchItemFailures };
}

async function processRecord(record: SQSRecord): Promise<void> {
  const job = parseProcessWardrobeItemJob(record.body);
  if (!job) {
    logger.warn('Dropping poison processing message', {
      messageId: record.messageId,
      receiveCount: record.attributes.ApproximateReceiveCount,
    });
    return;
  }

  logger.info('Processing clothing-item job', {
    messageId: record.messageId,
    jobType: job.jobType,
    itemId: job.itemId,
    wardrobeId: job.wardrobeId,
    receiveCount: record.attributes.ApproximateReceiveCount,
  });

  const item = await loadItemForJob(job);
  if (!item) {
    return;
  }

  const originalImageKey = itemOriginalKey(item);
  if (originalImageKey !== job.originalImageKey) {
    logger.warn('originalImageKey does not match DynamoDB item', {
      itemId: job.itemId,
      wardrobeId: job.wardrobeId,
    });
    await markFailed(job.wardrobeId, job.itemId);
    return;
  }

  if (item.processingStatus === 'READY') {
    logger.info('Clothing item already READY; skipping pipeline', {
      itemId: job.itemId,
      wardrobeId: job.wardrobeId,
    });
    return;
  }

  const marked = await setProcessingStatus(
    job.wardrobeId,
    job.itemId,
    'PROCESSING',
  );
  if (!marked) {
    return;
  }

  try {
    await runProcessingPipeline({
      userId: String(item.userId),
      wardrobeId: String(item.wardrobeId),
      itemId: String(item.itemId),
      originalImageKey,
      item,
    });
  } catch (error) {
    if (error instanceof PermanentProcessingError) {
      logger.error('Permanent pipeline failure', {
        itemId: job.itemId,
        wardrobeId: job.wardrobeId,
        error: error.message,
      });
      await markFailed(job.wardrobeId, job.itemId);
      return;
    }
    throw error instanceof RetryableProcessingError
      ? error
      : new RetryableProcessingError(
          error instanceof Error ? error.message : 'Pipeline failed',
          error,
        );
  }

  await setProcessingStatus(job.wardrobeId, job.itemId, 'READY');
  logger.info('Clothing item processing completed', {
    itemId: job.itemId,
    wardrobeId: job.wardrobeId,
    processingStatus: 'READY',
  });
}

async function loadItemForJob(
  job: ProcessWardrobeItemJob,
): Promise<DynamoItem | undefined> {
  let item: DynamoItem | undefined;
  try {
    item = await getItem(keys.wardrobePk(job.wardrobeId), keys.itemSk(job.itemId));
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
          error instanceof Error ? error.message : 'Failed to load clothing item',
          error,
        );
  }

  if (!item) {
    logger.warn('Dropping job for missing clothing item', {
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
    logger.warn('Dropping job that failed DynamoDB ownership validation', {
      itemId: job.itemId,
      wardrobeId: job.wardrobeId,
    });
    return undefined;
  }

  return item;
}

function itemOriginalKey(item: DynamoItem): string | undefined {
  return typeof item.originalKey === 'string' ? item.originalKey : undefined;
}

async function markFailed(wardrobeId: string, itemId: string): Promise<void> {
  await setProcessingStatus(wardrobeId, itemId, 'FAILED');
}

async function setProcessingStatus(
  wardrobeId: string,
  itemId: string,
  processingStatus: ProcessingStatus,
): Promise<boolean> {
  try {
    await updateAttributes(keys.wardrobePk(wardrobeId), keys.itemSk(itemId), {
      processingStatus,
      updatedAt: nowIso(),
    });
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      logger.warn('Item disappeared while updating processing status', {
        itemId,
        wardrobeId,
        processingStatus,
      });
      return false;
    }
    throw error instanceof RetryableProcessingError
      ? error
      : new RetryableProcessingError(
          error instanceof Error
            ? error.message
            : 'Failed to update processing status',
          error,
        );
  }
}
