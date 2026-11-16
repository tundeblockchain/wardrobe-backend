import { SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { logger } from '../../shared/logger';
import {
  OwnerNotifySendDeps,
  parseOwnerNotifyMessage,
  sendOwnerNotify,
} from '../../shared/owner-notify';

export interface OwnerNotifyHandlerDeps extends OwnerNotifySendDeps {}

/**
 * SQS worker for OWNER_NOTIFY (WARDROBE-273).
 *
 * Webhook Lambdas enqueue after Stripe / Superwall handling so SES never
 * sits on the webhook timeout. Failures are logged and retried via SQS;
 * poison payloads are acked. Dedupe lives in sendOwnerNotify.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  return handleOwnerNotifyQueue(event);
}

export async function handleOwnerNotifyQueue(
  event: SQSEvent,
  deps: OwnerNotifyHandlerDeps = {},
): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];
  const log = deps.log ?? logger;

  for (const record of event.Records) {
    try {
      await processRecord(record, deps);
    } catch (error) {
      log.error('Owner notify record failed', {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : 'unknown',
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}

async function processRecord(
  record: SQSRecord,
  deps: OwnerNotifyHandlerDeps,
): Promise<void> {
  const log = deps.log ?? logger;
  const message = parseOwnerNotifyMessage(record.body);
  if (!message) {
    log.warn('Owner notify poison payload acked', {
      messageId: record.messageId,
    });
    return;
  }
  await sendOwnerNotify(message, deps);
}
