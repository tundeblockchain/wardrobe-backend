import { putItemIfNotExists } from '../../shared/dynamodb';
import { logger } from '../../shared/logger';
import { sendJobDonePush } from './fcm';
import { jobEventId, toJobEventItem } from './model';
import { JobDoneInput } from './model';

export type { JobDoneInput } from './model';

/**
 * Persist a durable job-done inbox row, then optionally push FCM.
 *
 * Writes are idempotent (`putItemIfNotExists` on a deterministic eventId).
 * Push and Dynamo failures are logged and swallowed — workers already wrote
 * the item/outfit terminal status Flutter can still poll.
 */
export async function recordJobDone(input: JobDoneInput): Promise<boolean> {
  const eventId = jobEventId(input);
  if (!input.userId || !input.wardrobeId || !eventId.startsWith('evt_')) {
    logger.warn('Skipping job-done event: missing identity fields', {
      jobType: input.jobType,
      status: input.status,
    });
    return false;
  }
  if (input.jobType === 'PROCESS_WARDROBE_ITEM' && !input.itemId) {
    logger.warn('Skipping item job-done event: missing itemId');
    return false;
  }
  if (input.jobType === 'RENDER_OUTFIT' && !input.outfitId) {
    logger.warn('Skipping try-on job-done event: missing outfitId');
    return false;
  }

  let created = false;
  try {
    created = await putItemIfNotExists(toJobEventItem(input));
  } catch (error) {
    logger.error('Job-done event write failed', {
      eventId,
      jobType: input.jobType,
      status: input.status,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }

  if (!created) {
    logger.info('Job-done event already exists; skipping push', { eventId });
    return false;
  }

  try {
    await sendJobDonePush(input, eventId);
  } catch (error) {
    logger.warn('FCM push soft-failed after job-done event write', {
      eventId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }

  logger.info('Recorded job-done event', {
    eventId,
    jobType: input.jobType,
    status: input.status,
  });
  return true;
}
