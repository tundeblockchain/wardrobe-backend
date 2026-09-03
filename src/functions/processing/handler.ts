import { SQSEvent } from 'aws-lambda';
import { logger } from '../../shared/logger';

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    logger.info('Received processing job', {
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
