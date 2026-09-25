import { DynamoItem } from '../../src/shared/types';

const mockDynamoSend = jest.fn();
const mockSendJobDonePush = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockDynamoSend })),
  },
  PutCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Put',
    input,
  })),
  GetCommand: jest.fn(),
  QueryCommand: jest.fn(),
  UpdateCommand: jest.fn(),
  DeleteCommand: jest.fn(),
}));

jest.mock('../../src/functions/events/fcm', () => ({
  sendJobDonePush: (...args: unknown[]) => mockSendJobDonePush(...args),
}));

import { jobEventId } from '../../src/functions/events/ids';
import { recordJobDone } from '../../src/functions/events/record';

describe('recordJobDone (WARDROBE-114)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
    mockSendJobDonePush.mockResolvedValue({ attempted: 0, sent: 0 });
  });

  afterEach(() => {
    delete process.env.TABLE_NAME;
  });

  it('writes a deterministic item event and then attempts push', async () => {
    mockDynamoSend.mockResolvedValue({});

    const created = await recordJobDone({
      userId: 'uid-1',
      jobType: 'PROCESS_WARDROBE_ITEM',
      status: 'READY',
      wardrobeId: 'wd_1',
      itemId: 'item_1',
    });

    expect(created).toBe(true);
    const put = mockDynamoSend.mock.calls[0][0] as {
      _op: string;
      input: { Item: DynamoItem; ConditionExpression?: string };
    };
    expect(put.input.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(put.input.Item).toMatchObject({
      PK: 'USER#uid-1',
      SK: 'EVENT#evt_item_item_1_READY',
      entityType: 'JOB_EVENT',
      eventId: 'evt_item_item_1_READY',
      jobType: 'PROCESS_WARDROBE_ITEM',
      status: 'READY',
      itemId: 'item_1',
    });
    expect(put.input.Item.error).toBeUndefined();
    expect(typeof put.input.Item.ttl).toBe('number');
    expect(mockSendJobDonePush).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'item_1' }),
      'evt_item_item_1_READY',
    );
  });

  it('is idempotent when the event already exists and skips push', async () => {
    const exists = new Error('already there');
    exists.name = 'ConditionalCheckFailedException';
    mockDynamoSend.mockRejectedValue(exists);

    const created = await recordJobDone({
      userId: 'uid-1',
      jobType: 'RENDER_OUTFIT',
      status: 'FAILED',
      wardrobeId: 'wd_1',
      outfitId: 'outfit_1',
      renderId: 'rend_1',
      aiProfileId: 'profile_1',
      error: 'Gemini blocked',
    });

    expect(created).toBe(false);
    expect(mockSendJobDonePush).not.toHaveBeenCalled();
    expect(jobEventId({
      jobType: 'RENDER_OUTFIT',
      status: 'FAILED',
      renderId: 'rend_1',
    })).toBe('evt_render_rend_1_FAILED');
  });

  it('writes a RENDER_ITEM event keyed by renderId', async () => {
    mockDynamoSend.mockResolvedValue({});

    const created = await recordJobDone({
      userId: 'uid-1',
      jobType: 'RENDER_ITEM',
      status: 'READY',
      wardrobeId: 'wd_1',
      itemId: 'item_1',
      renderId: 'rend_item1',
      aiProfileId: 'profile_1',
    });

    expect(created).toBe(true);
    const put = mockDynamoSend.mock.calls[0][0] as {
      input: { Item: DynamoItem };
    };
    expect(put.input.Item).toMatchObject({
      eventId: 'evt_render_rend_item1_READY',
      jobType: 'RENDER_ITEM',
      itemId: 'item_1',
      renderId: 'rend_item1',
    });
  });

  it('skips RENDER_ITEM when itemId is missing', async () => {
    const created = await recordJobDone({
      userId: 'uid-1',
      jobType: 'RENDER_ITEM',
      status: 'READY',
      wardrobeId: 'wd_1',
      renderId: 'rend_item1',
    });

    expect(created).toBe(false);
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it('swallows Dynamo write failures so workers do not 5xx', async () => {
    mockDynamoSend.mockRejectedValue(new Error('Throughput exceeds the current capacity'));

    await expect(
      recordJobDone({
        userId: 'uid-1',
        jobType: 'PROCESS_WARDROBE_ITEM',
        status: 'FAILED',
        wardrobeId: 'wd_1',
        itemId: 'item_1',
        error: 'timeout',
      }),
    ).resolves.toBe(false);
  });

  it('swallows FCM failures after a successful write', async () => {
    mockDynamoSend.mockResolvedValue({});
    mockSendJobDonePush.mockRejectedValue(new Error('network down'));

    await expect(
      recordJobDone({
        userId: 'uid-1',
        jobType: 'PROCESS_WARDROBE_ITEM',
        status: 'READY',
        wardrobeId: 'wd_1',
        itemId: 'item_1',
      }),
    ).resolves.toBe(true);
  });
});
