const mockDynamoSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockDynamoSend })),
  },
  QueryCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Query',
    input,
  })),
  UpdateCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Update',
    input,
  })),
  GetCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Get',
    input,
  })),
  PutCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Put',
    input,
  })),
  DeleteCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Delete',
    input,
  })),
  TransactWriteCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'TransactWrite',
    input,
  })),
}));

import {
  countUnreadConversationsByUid,
  SUPPORT_UNREAD_COUNT_PROJECTION,
} from '../../src/functions/support-inbox/table';
import { UID_LAST_MESSAGE_INDEX } from '../../src/functions/support-inbox/keys';
import { SUPPORT_UNREAD_COUNT_MAX } from '../../src/shared/support-inbox-names';

function unreadItem(index: number): Record<string, unknown> {
  return {
    PK: `CONV#conv_${index}`,
    SK: 'META',
    uid: 'firebase-uid-owner',
    lastMessageAuthor: 'admin',
    lastMessageAt: '2026-01-02T00:00:00.000Z',
    lastAdminMessageAt: '2026-01-02T00:00:00.000Z',
  };
}

describe('support inbox unreadCount GSI query (WARDROBE-286)', () => {
  const previousTable = process.env.SUPPORT_TABLE_NAME;

  beforeEach(() => {
    mockDynamoSend.mockReset();
    process.env.SUPPORT_TABLE_NAME = 'wardrobe-support-test';
  });

  afterAll(() => {
    if (previousTable === undefined) {
      delete process.env.SUPPORT_TABLE_NAME;
    } else {
      process.env.SUPPORT_TABLE_NAME = previousTable;
    }
  });

  it('pages UidLastMessageIndex with the unread projection and stops after scanning SUPPORT_UNREAD_COUNT_MAX', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Items: Array.from({ length: SUPPORT_UNREAD_COUNT_MAX }, (_, index) =>
        unreadItem(index),
      ),
      LastEvaluatedKey: { PK: 'CONV#more', SK: 'META' },
    });

    const unread = await countUnreadConversationsByUid({
      uid: 'firebase-uid-owner',
    });

    expect(unread).toBe(SUPPORT_UNREAD_COUNT_MAX);
    expect(mockDynamoSend).toHaveBeenCalledTimes(1);
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        _op: 'Query',
        input: expect.objectContaining({
          TableName: 'wardrobe-support-test',
          IndexName: UID_LAST_MESSAGE_INDEX,
          Limit: SUPPORT_UNREAD_COUNT_MAX,
          ProjectionExpression: SUPPORT_UNREAD_COUNT_PROJECTION,
          KeyConditionExpression: '#uid = :uid',
        }),
      }),
    );
    const query = mockDynamoSend.mock.calls[0][0] as {
      input: { ProjectionExpression: string };
    };
    expect(query.input.ProjectionExpression).toContain('PK');
    expect(query.input.ProjectionExpression).toContain('lastAdminMessageAt');
    expect(query.input.ProjectionExpression).toContain('lastReadAt');
    expect(query.input.ProjectionExpression).not.toContain('lastMessagePreview');
    expect(query.input.ProjectionExpression).not.toContain('email');
  });
});
