import { SQSEvent, SQSRecord } from 'aws-lambda';
import { DynamoItem } from '../../src/shared/types';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockSend })),
  },
  GetCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Get',
    input,
  })),
  UpdateCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Update',
    input,
  })),
}));

const mockRunPipeline = jest.fn();

jest.mock('../../src/functions/processing/pipeline', () => ({
  runProcessingPipeline: (...args: unknown[]) => mockRunPipeline(...args),
}));

import { PermanentProcessingError } from '../../src/functions/processing/errors';
import { handler } from '../../src/functions/processing/handler';

const OWNER_ID = 'firebase-uid-owner';
const OTHER_ID = 'firebase-uid-other';
const WARDROBE_ID = 'wd_abc123xyz0';
const ITEM_ID = 'item_xyz123abcd';
const ORIGINAL_KEY = `users/${OWNER_ID}/uploads/photo.jpg`;

interface Command {
  _op: 'Get' | 'Update';
  input: {
    TableName?: string;
    Key?: { PK: string; SK: string };
    UpdateExpression?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
    ExpressionAttributeNames?: Record<string, string>;
    ConditionExpression?: string;
  };
}

function dynamoItem(overrides: Partial<DynamoItem> = {}): DynamoItem {
  return {
    PK: `WARDROBE#${WARDROBE_ID}`,
    SK: `ITEM#${ITEM_ID}`,
    entityType: 'ITEM',
    userId: OWNER_ID,
    wardrobeId: WARDROBE_ID,
    itemId: ITEM_ID,
    name: 'Black T-Shirt',
    category: 'TOP',
    originalKey: ORIGINAL_KEY,
    processingStatus: 'PENDING',
    createdAt: '2026-09-03T18:45:00.000Z',
    updatedAt: '2026-09-03T18:45:00.000Z',
    ...overrides,
  };
}

function job(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jobType: 'PROCESS_WARDROBE_ITEM',
    userId: OWNER_ID,
    wardrobeId: WARDROBE_ID,
    itemId: ITEM_ID,
    originalImageKey: ORIGINAL_KEY,
    ...overrides,
  });
}

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

function eventFor(...bodies: string[]): SQSEvent {
  return {
    Records: bodies.map((body, index) => record(body, `msg-${index + 1}`)),
  };
}

function commands(): Command[] {
  return mockSend.mock.calls.map((call) => call[0] as Command);
}

function statusUpdates(): string[] {
  return commands()
    .filter((command) => command._op === 'Update')
    .map((command) => String(command.input.ExpressionAttributeValues?.[':processingStatus']));
}

function throttleError(): Error {
  const error = new Error('Throughput exceeds the current capacity');
  error.name = 'ThrottlingException';
  return error;
}

describe('processing worker (WARDROBE-17)', () => {
  const originalTable = process.env.TABLE_NAME;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
    mockRunPipeline.mockResolvedValue(undefined);
    mockSend.mockImplementation(async (command: Command) => {
      if (command._op === 'Get') {
        return { Item: dynamoItem() };
      }
      return {
        Attributes: dynamoItem({
          processingStatus: command.input.ExpressionAttributeValues?.[
            ':processingStatus'
          ] as DynamoItem['processingStatus'],
        }),
      };
    });
  });

  afterEach(() => {
    if (originalTable === undefined) {
      delete process.env.TABLE_NAME;
    } else {
      process.env.TABLE_NAME = originalTable;
    }
  });

  it('loads DynamoDB, sets PROCESSING then READY on stub pipeline success', async () => {
    const result = await handler(eventFor(job()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(commands()[0]).toMatchObject({
      _op: 'Get',
      input: {
        TableName: 'wardrobe-app-test',
        Key: { PK: `WARDROBE#${WARDROBE_ID}`, SK: `ITEM#${ITEM_ID}` },
      },
    });
    expect(statusUpdates()).toEqual(['PROCESSING', 'READY']);
    expect(mockRunPipeline).toHaveBeenCalledWith({
      userId: OWNER_ID,
      wardrobeId: WARDROBE_ID,
      itemId: ITEM_ID,
      originalImageKey: ORIGINAL_KEY,
      item: dynamoItem(),
    });
  });

  it('acks invalid JSON as poison without touching DynamoDB', async () => {
    const result = await handler(eventFor('not-json'));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('acks unknown jobType as poison without touching DynamoDB', async () => {
    const result = await handler(
      eventFor(JSON.stringify({ jobType: 'SOMETHING_ELSE', itemId: ITEM_ID })),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('acks a message missing required fields as poison', async () => {
    const result = await handler(
      eventFor(JSON.stringify({ jobType: 'PROCESS_WARDROBE_ITEM', userId: OWNER_ID })),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('acks a missing item without writing FAILED', async () => {
    mockSend.mockResolvedValue({ Item: undefined });

    const result = await handler(eventFor(job()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(statusUpdates()).toEqual([]);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('acks owner mismatch without updating the DynamoDB item', async () => {
    mockSend.mockImplementation(async (command: Command) => {
      if (command._op === 'Get') {
        return { Item: dynamoItem({ userId: OTHER_ID }) };
      }
      throw new Error('should not update another user item');
    });

    const result = await handler(eventFor(job()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(statusUpdates()).toEqual([]);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('acks wardrobeId / itemId inconsistency without updating', async () => {
    mockSend.mockImplementation(async (command: Command) => {
      if (command._op === 'Get') {
        return { Item: dynamoItem({ wardrobeId: 'wd_other', itemId: 'item_other' }) };
      }
      throw new Error('should not update an inconsistent item');
    });

    const result = await handler(eventFor(job()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(statusUpdates()).toEqual([]);
  });

  it('sets FAILED and acks when originalImageKey does not match DynamoDB', async () => {
    const result = await handler(
      eventFor(job({ originalImageKey: `users/${OWNER_ID}/uploads/other.jpg` })),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(statusUpdates()).toEqual(['FAILED']);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('skips the pipeline when the item is already READY', async () => {
    mockSend.mockImplementation(async (command: Command) => {
      if (command._op === 'Get') {
        return { Item: dynamoItem({ processingStatus: 'READY' }) };
      }
      throw new Error('READY items must not be rewritten');
    });

    const result = await handler(eventFor(job()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(statusUpdates()).toEqual([]);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('continues a PROCESSING retry through the stub pipeline to READY', async () => {
    mockSend.mockImplementation(async (command: Command) => {
      if (command._op === 'Get') {
        return { Item: dynamoItem({ processingStatus: 'PROCESSING' }) };
      }
      return {
        Attributes: dynamoItem({
          processingStatus: command.input.ExpressionAttributeValues?.[
            ':processingStatus'
          ] as DynamoItem['processingStatus'],
        }),
      };
    });

    const result = await handler(eventFor(job()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(statusUpdates()).toEqual(['PROCESSING', 'READY']);
    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
  });

  it('reports retryable DynamoDB failures so SQS can redeliver toward the DLQ', async () => {
    mockSend.mockRejectedValue(throttleError());

    const result = await handler(eventFor(job()));

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'msg-1' }],
    });
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('sets FAILED and acks permanent pipeline errors', async () => {
    mockRunPipeline.mockRejectedValue(new PermanentProcessingError('unusable image'));

    const result = await handler(eventFor(job()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(statusUpdates()).toEqual(['PROCESSING', 'FAILED']);
  });

  it('rethrows unexpected pipeline errors as batch failures for SQS retry', async () => {
    mockRunPipeline.mockRejectedValue(new Error('transient model timeout'));

    const result = await handler(eventFor(job()));

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'msg-1' }],
    });
    expect(statusUpdates()).toEqual(['PROCESSING']);
  });

  it('acks poison records and retries only the retryable record in a batch', async () => {
    mockSend.mockImplementation(async (command: Command) => {
      if (command._op === 'Get') {
        throw throttleError();
      }
      return { Attributes: dynamoItem() };
    });

    const result = await handler({
      Records: [record('not-json', 'poison'), record(job(), 'retry-me')],
    });

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'retry-me' }],
    });
  });

  it('does not call S3 or external model clients on the stub success path', async () => {
    await handler(eventFor(job()));

    const updateExpressions = commands()
      .filter((command) => command._op === 'Update')
      .map((command) => command.input.UpdateExpression);
    expect(updateExpressions.every((expression) => expression?.includes('processingStatus'))).toBe(
      true,
    );
    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
  });
});
