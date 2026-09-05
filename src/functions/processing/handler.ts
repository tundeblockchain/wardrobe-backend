import { SQSEvent } from 'aws-lambda';
import { logger } from '../../shared/logger';

/**
 * WARDROBE-15 hook: clothing-item processing worker.
 * Intentionally a no-op stub — enqueue (WARDROBE-16), worker status
 * updates (WARDROBE-17), and AI / background removal (WARDROBE-18–20)
 * are later tickets. Do not add classification or image work here.
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
