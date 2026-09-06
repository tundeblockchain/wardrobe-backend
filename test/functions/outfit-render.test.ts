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
  QueryCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Query',
    input,
  })),
  UpdateCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Update',
    input,
  })),
}));

const mockRunTryOn = jest.fn();

jest.mock('../../src/functions/processing/try-on', () => ({
  runOutfitTryOn: (...args: unknown[]) => mockRunTryOn(...args),
}));

import { PermanentProcessingError } from '../../src/functions/processing/errors';
import { handler } from '../../src/functions/outfit-render/handler';

const OWNER_ID = 'firebase-uid-owner';
const OTHER_ID = 'firebase-uid-other';
const WARDROBE_ID = 'wd_abc123xyz0';
const OUTFIT_ID = 'outfit_xyz123ab';
const PROFILE_ID = 'profile_generic_01';
const TOP_ITEM_ID = 'item_top123abcd';
const RENDER_KEY = `users/${OWNER_ID}/outfits/${OUTFIT_ID}/render.png`;

interface Command {
  _op: 'Get' | 'Query' | 'Update';
  input: {
    TableName?: string;
    Key?: { PK: string; SK: string };
    UpdateExpression?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
    ExpressionAttributeNames?: Record<string, string>;
  };
}

function dynamoOutfit(overrides: Partial<DynamoItem> = {}): DynamoItem {
  return {
    PK: `WARDROBE#${WARDROBE_ID}`,
    SK: `OUTFIT#${OUTFIT_ID}`,
    entityType: 'OUTFIT',
    userId: OWNER_ID,
    wardrobeId: WARDROBE_ID,
    outfitId: OUTFIT_ID,
    name: 'Friday Night',
    items: [{ itemId: TOP_ITEM_ID, slot: 'TOP' }],
    render: { status: 'PENDING', aiProfileId: PROFILE_ID },
    createdAt: '2026-09-06T08:00:00.000Z',
    updatedAt: '2026-09-06T08:00:00.000Z',
    ...overrides,
  };
}

function dynamoItem(): DynamoItem {
  return {
    PK: `WARDROBE#${WARDROBE_ID}`,
    SK: `ITEM#${TOP_ITEM_ID}`,
    entityType: 'ITEM',
    userId: OWNER_ID,
    wardrobeId: WARDROBE_ID,
    itemId: TOP_ITEM_ID,
    name: 'Tee',
    category: 'TOP',
    originalKey: `users/${OWNER_ID}/uploads/tee.jpg`,
    processedKey: `users/${OWNER_ID}/items/${TOP_ITEM_ID}/processed.png`,
    processingStatus: 'READY',
    createdAt: '2026-09-06T08:00:00.000Z',
    updatedAt: '2026-09-06T08:00:00.000Z',
  };
}

function dynamoGenericProfile(): DynamoItem {
  return {
    PK: 'AIPROFILE#GENERIC_MODEL',
    SK: `AIPROFILE#${PROFILE_ID}`,
    entityType: 'AIPROFILE',
    userId: 'SYSTEM',
    aiProfileId: PROFILE_ID,
    type: 'GENERIC_MODEL',
    referenceImages: ['shared/ai-profiles/generic/alex/front.jpg'],
    status: 'READY',
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
  };
}

function job(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jobType: 'RENDER_OUTFIT',
    userId: OWNER_ID,
    wardrobeId: WARDROBE_ID,
    outfitId: OUTFIT_ID,
    aiProfileId: PROFILE_ID,
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
    eventSourceARN: 'arn:aws:sqs:eu-west-1:123:wardrobe-outfit-render-dev',
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

function renderUpdates(): Array<Record<string, unknown>> {
  return commands()
    .filter((command) => command._op === 'Update')
    .map(
      (command) =>
        (command.input.ExpressionAttributeValues?.[':render'] as Record<
          string,
          unknown
        >) ?? {},
    );
}

function throttleError(): Error {
  const error = new Error('Throughput exceeds the current capacity');
  error.name = 'ThrottlingException';
  return error;
}

describe('outfit render worker (WARDROBE-47)', () => {
  const originalTable = process.env.TABLE_NAME;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
    mockRunTryOn.mockResolvedValue(RENDER_KEY);
    mockSend.mockImplementation(async (command: Command) => {
      if (command._op === 'Get') {
        const sk = command.input.Key?.SK ?? '';
        const pk = command.input.Key?.PK ?? '';
        if (sk.startsWith('OUTFIT#')) {
          return { Item: dynamoOutfit() };
        }
        if (sk.startsWith('ITEM#')) {
          return { Item: dynamoItem() };
        }
        if (pk === 'AIPROFILE#GENERIC_MODEL') {
          return { Item: dynamoGenericProfile() };
        }
        return { Item: undefined };
      }
      return { Attributes: dynamoOutfit() };
    });
  });

  afterEach(() => {
    if (originalTable === undefined) {
      delete process.env.TABLE_NAME;
    } else {
      process.env.TABLE_NAME = originalTable;
    }
  });

  it('loads Dynamo, sets PROCESSING then READY, and calls try-on', async () => {
    const result = await handler(eventFor(job()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(renderUpdates().map((render) => render.status)).toEqual([
      'PROCESSING',
      'READY',
    ]);
    expect(renderUpdates()[1]).toMatchObject({
      status: 'READY',
      aiProfileId: PROFILE_ID,
      imageKey: RENDER_KEY,
    });
    expect(mockRunTryOn).toHaveBeenCalledWith({
      userId: OWNER_ID,
      outfitId: OUTFIT_ID,
      profileImageKeys: ['shared/ai-profiles/generic/alex/front.jpg'],
      garmentImages: [
        {
          slot: 'TOP',
          objectKey: `users/${OWNER_ID}/items/${TOP_ITEM_ID}/processed.png`,
        },
      ],
    });
  });

  it('acks invalid JSON as poison without touching DynamoDB', async () => {
    const result = await handler(eventFor('not-json'));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockRunTryOn).not.toHaveBeenCalled();
  });

  it('acks PROCESS_WARDROBE_ITEM as poison on the try-on queue', async () => {
    const result = await handler(
      eventFor(JSON.stringify({ jobType: 'PROCESS_WARDROBE_ITEM', itemId: 'x' })),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('acks a missing outfit without writing FAILED', async () => {
    mockSend.mockResolvedValue({ Item: undefined });

    const result = await handler(eventFor(job()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(renderUpdates()).toEqual([]);
    expect(mockRunTryOn).not.toHaveBeenCalled();
  });

  it('acks owner mismatch without updating the outfit', async () => {
    mockSend.mockImplementation(async (command: Command) => {
      if (command._op === 'Get' && command.input.Key?.SK?.startsWith('OUTFIT#')) {
        return { Item: dynamoOutfit({ userId: OTHER_ID }) };
      }
      throw new Error('should not continue after owner mismatch');
    });

    const result = await handler(eventFor(job()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(renderUpdates()).toEqual([]);
  });

  it('skips try-on when the outfit is already READY for the same profile', async () => {
    mockSend.mockImplementation(async (command: Command) => {
      if (command._op === 'Get' && command.input.Key?.SK?.startsWith('OUTFIT#')) {
        return {
          Item: dynamoOutfit({
            render: {
              status: 'READY',
              aiProfileId: PROFILE_ID,
              imageKey: RENDER_KEY,
            },
          }),
        };
      }
      throw new Error('READY outfits must not be rewritten');
    });

    const result = await handler(eventFor(job()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockRunTryOn).not.toHaveBeenCalled();
  });

  it('sets FAILED and acks permanent Gemini errors', async () => {
    mockRunTryOn.mockRejectedValue(
      new PermanentProcessingError('Gemini blocked the try-on request (SAFETY)'),
    );

    const result = await handler(eventFor(job()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(renderUpdates().map((render) => render.status)).toEqual([
      'PROCESSING',
      'FAILED',
    ]);
    expect(renderUpdates()[1].error).toBe(
      'Gemini blocked the try-on request (SAFETY)',
    );
  });

  it('reports retryable failures so SQS can redeliver toward the DLQ', async () => {
    mockSend.mockRejectedValue(throttleError());

    const result = await handler(eventFor(job()));

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'msg-1' }],
    });
    expect(mockRunTryOn).not.toHaveBeenCalled();
  });

  it('acks poison records and retries only the retryable record in a batch', async () => {
    mockSend.mockImplementation(async (command: Command) => {
      if (command._op === 'Get' && command.input.Key?.SK?.startsWith('OUTFIT#')) {
        throw throttleError();
      }
      return { Attributes: dynamoOutfit() };
    });

    const result = await handler({
      Records: [record('not-json', 'poison'), record(job(), 'retry-me')],
    });

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'retry-me' }],
    });
  });
});
