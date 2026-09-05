import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { AppError, Errors } from './errors';
import { logger } from './logger';
import {
  PROCESS_WARDROBE_ITEM_JOB,
  ProcessWardrobeItemJob,
} from './types';

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
