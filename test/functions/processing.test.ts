import { SQSEvent, SQSRecord } from 'aws-lambda';
import { handler } from '../../src/functions/processing/handler';

function record(body: string, messageId = 'msg-1'): SQSRecord {
  return {
    messageId,
    receiptHandle: 'rh',
    body,
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: '0',
      SenderId: 'sender',
      ApproximateFirstReceiveTimestamp: '0',
    },
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:eu-west-1:123:wardrobe-item-processing-dev',
    awsRegion: 'eu-west-1',
  };
}

describe('processing worker (WARDROBE-15 no-op hook)', () => {
  it('is a no-op that logs SQS messages and does not throw', async () => {
    const event: SQSEvent = {
      Records: [record(JSON.stringify({ jobType: 'PROCESS_WARDROBE_ITEM' }))],
    };

    await expect(handler(event)).resolves.toBeUndefined();
  });

  it('tolerates invalid JSON without attempting AI work', async () => {
    const event: SQSEvent = {
      Records: [record('not-json')],
    };

    await expect(handler(event)).resolves.toBeUndefined();
  });
});
