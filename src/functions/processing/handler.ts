import { SQSEvent } from 'aws-lambda';
import { logger } from '../../shared/logger';

/**
 * Phase-2 hook: clothing-item processing worker.
 * Intentionally a no-op stub — AI classification and background removal
 * are out of scope for the WARDROBE-4 CDK foundation.
 */
export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    logger.info('Received processing job (Phase-2 stub; no AI)', {
      messageId: record.messageId,
      body: safeParse(record.body),
    });
  }
}

function safeParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return { raw: body };
  }
}
