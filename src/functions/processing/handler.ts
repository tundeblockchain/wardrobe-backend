import { SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { getItem, keys, updateAttributes } from '../../shared/dynamodb';
import { nowIso } from '../../shared/ids';
import { logger } from '../../shared/logger';
import { parseProcessWardrobeItemJob } from '../../shared/sqs';
import {
  DynamoItem,
  ITEM_PROCESSING_MAX_RECEIVE_COUNT,
  ProcessingStatus,
  ProcessWardrobeItemJob,
} from '../../shared/types';
import {
  isRetryableProcessingFailure,
  PermanentProcessingError,
  RetryableProcessingError,
} from './errors';
import { runProcessingPipeline } from './pipeline';

const EXHAUSTED_ERROR = 'Processing retries exhausted';
const KEY_MISMATCH_ERROR = 'originalImageKey does not match stored item';
const PROCESSING_ERROR_MAX_LENGTH = 240;

/**
 * SQS worker for PROCESS_WARDROBE_ITEM.
 *
 * DynamoDB is the source of truth. The SQS body is only a pointer;
 * owner, wardrobe, item, and originalImageKey are re-checked on load.
 *
 * Status machine (WARDROBE-17 / WARDROBE-59):
 *   PENDING → PROCESSING → READY   (pipeline success)
 *   *       → FAILED               (permanent / validation / exhausted retries)
 *
 * Retryable failures throw/report batch item failures so SQS redelivers.
 * On the last receive (maxReceiveCount) or a DLQ record, Dynamo is marked
 * FAILED and the message is acked. Poison messages are acked so they do
 * not cycle the retry budget.
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
          receiveCount: record.attributes.ApproximateReceiveCount,
          error: error instanceof Error ? error.message : 'unknown',
        });

        if (isTerminalReceive(record)) {
          try {
            await persistTerminalFailure(record, error);
            continue;
          } catch (markError) {
            if (isRetryableProcessingFailure(markError)) {
              batchItemFailures.push({ itemIdentifier: record.messageId });
              continue;
            }
            continue;
          }
        }

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
    fromDlq: isDlqRecord(record),
  });

  // WARDROBE-59: DLQ is the safety net for timeouts / crashes that never
  // reached markFailed. Do not re-run the pipeline.
  if (isDlqRecord(record)) {
    await markFailed(job.wardrobeId, job.itemId, EXHAUSTED_ERROR);
    return;
  }

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
    await markFailed(job.wardrobeId, job.itemId, KEY_MISMATCH_ERROR);
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
      await markFailed(job.wardrobeId, job.itemId, error.message);
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

function isDlqRecord(record: SQSRecord): boolean {
  const dlqArn = process.env.PROCESSING_DLQ_ARN;
  return Boolean(dlqArn && record.eventSourceARN === dlqArn);
}

function receiveCount(record: SQSRecord): number {
  const raw = Number.parseInt(
    record.attributes.ApproximateReceiveCount ?? '1',
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function isLastReceive(record: SQSRecord): boolean {
  return receiveCount(record) >= ITEM_PROCESSING_MAX_RECEIVE_COUNT;
}

function isTerminalReceive(record: SQSRecord): boolean {
  return isDlqRecord(record) || isLastReceive(record);
}

function sanitizeProcessingError(reason: string): string {
  const trimmed = reason.replace(/\s+/g, ' ').trim();
  if (!trimmed) {
    return EXHAUSTED_ERROR;
  }
  return trimmed.length > PROCESSING_ERROR_MAX_LENGTH
    ? trimmed.slice(0, PROCESSING_ERROR_MAX_LENGTH)
    : trimmed;
}

async function persistTerminalFailure(
  record: SQSRecord,
  error: unknown,
): Promise<void> {
  const job = parseProcessWardrobeItemJob(record.body);
  if (!job) {
    return;
  }

  const reason =
    error instanceof Error && error.message.trim()
      ? error.message
      : EXHAUSTED_ERROR;

  await markFailed(job.wardrobeId, job.itemId, reason);
}

async function markFailed(
  wardrobeId: string,
  itemId: string,
  reason: string,
): Promise<void> {
  await setProcessingStatus(wardrobeId, itemId, 'FAILED', reason);
}

async function setProcessingStatus(
  wardrobeId: string,
  itemId: string,
  processingStatus: ProcessingStatus,
  processingError?: string,
): Promise<boolean> {
  try {
    const attributes: Record<string, unknown> = {
      processingStatus,
      updatedAt: nowIso(),
    };

    if (processingStatus === 'FAILED') {
      attributes.processingError = sanitizeProcessingError(
        processingError ?? EXHAUSTED_ERROR,
      );
      await updateAttributes(
        keys.wardrobePk(wardrobeId),
        keys.itemSk(itemId),
        attributes,
        {
          conditionExpression:
            'attribute_exists(PK) AND (attribute_not_exists(#processingStatus) OR #processingStatus <> :readyStatus)',
          extraValues: { ':readyStatus': 'READY' },
        },
      );
      return true;
    }

    await updateAttributes(
      keys.wardrobePk(wardrobeId),
      keys.itemSk(itemId),
      attributes,
      processingStatus === 'READY' ? { remove: ['processingError'] } : undefined,
    );
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      logger.warn('Item disappeared or is READY while updating processing status', {
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
