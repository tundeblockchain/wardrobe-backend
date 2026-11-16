import { SQSEvent, SQSRecord } from 'aws-lambda';
import { OWNER_NOTIFY_JOB } from '../../src/shared/types';
import { handleOwnerNotifyQueue } from '../../src/functions/owner-notify/handler';
import { OwnerNotifyMessage } from '../../src/shared/owner-notify';

function record(body: string, messageId = 'msg-1'): SQSRecord {
  return {
    messageId,
    receiptHandle: 'rh',
    body,
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: '1',
      SenderId: 'sender',
      ApproximateFirstReceiveTimestamp: '1',
    },
    messageAttributes: {},
    md5OfBody: 'md5',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:eu-west-1:123:wardrobe-owner-notify-dev',
    awsRegion: 'eu-west-1',
  };
}

function eventOf(...bodies: string[]): SQSEvent {
  return {
    Records: bodies.map((body, index) => record(body, `msg-${index + 1}`)),
  };
}

function payload(): OwnerNotifyMessage {
  return {
    jobType: OWNER_NOTIFY_JOB,
    eventType: 'subscribed',
    plan: 'premium',
    platform: 'web',
    price: 15,
    currency: 'GBP',
    userEmail: 'owner@example.com',
    userId: 'firebase-uid-owner',
    eventTimestamp: '2024-05-29T16:26:40.000Z',
    provider: 'stripe',
    providerEventId: 'evt_test_123',
  };
}

describe('OwnerNotifyFn (WARDROBE-273)', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends a valid message and acks it', async () => {
    const sendEmail = jest.fn().mockResolvedValue(undefined);
    const result = await handleOwnerNotifyQueue(eventOf(JSON.stringify(payload())), {
      claimEvent: async () => true,
      loadConfig: async () => ({
        recipient: 'owner@example.com',
        sender: 'sender@example.com',
      }),
      sendEmail,
      log,
    });

    expect(result).toEqual({ batchItemFailures: [] });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('acks a poison payload so it does not retry', async () => {
    const sendEmail = jest.fn();
    const result = await handleOwnerNotifyQueue(eventOf('{'), {
      sendEmail,
      log,
    });
    expect(result).toEqual({ batchItemFailures: [] });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Owner notify poison payload acked',
      expect.objectContaining({ messageId: 'msg-1' }),
    );
  });

  it('a retried event with the same provider event ID sends exactly one email', async () => {
    let claimed = false;
    const sendEmail = jest.fn().mockResolvedValue(undefined);
    const body = JSON.stringify(payload());
    const result = await handleOwnerNotifyQueue(
      {
        Records: [record(body, 'msg-1'), record(body, 'msg-2')],
      },
      {
        claimEvent: async () => {
          if (claimed) {
            return false;
          }
          claimed = true;
          return true;
        },
        loadConfig: async () => ({
          recipient: 'owner@example.com',
          sender: 'sender@example.com',
        }),
        sendEmail,
        log,
      },
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      'Owner notify skipped; event already sent',
      expect.objectContaining({ providerEventId: 'evt_test_123' }),
    );
  });

  it('reports a batch item failure when SES throws so SQS retries', async () => {
    const result = await handleOwnerNotifyQueue(eventOf(JSON.stringify(payload())), {
      claimEvent: async () => true,
      forgetEvent: async () => undefined,
      loadConfig: async () => ({
        recipient: 'owner@example.com',
        sender: 'sender@example.com',
      }),
      sendEmail: async () => {
        throw new Error('SES throttled');
      },
      log,
    });

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'msg-1' }],
    });
    expect(log.error).toHaveBeenCalledWith(
      'Owner notify SES send failed',
      expect.objectContaining({ providerEventId: 'evt_test_123' }),
    );
  });
});
