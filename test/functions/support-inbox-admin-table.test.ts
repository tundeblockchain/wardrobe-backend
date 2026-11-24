const mockDynamoSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockDynamoSend })),
  },
  UpdateCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Update',
    input,
  })),
  GetCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Get',
    input,
  })),
  QueryCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Query',
    input,
  })),
  TransactWriteCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'TransactWrite',
    input,
  })),
}));

import {
  SupportNotRetryableError,
  SupportValidationError,
} from '../../src/functions/support-inbox/http';
import {
  claimFailedAdminEmailRetry,
  listConversationsByStatus,
  updateMessageEmailStatus,
} from '../../src/functions/support-inbox/table';
import { SUPPORT_EMAIL_RETRY_CLAIM_STATUS } from '../../src/shared/support-inbox-names';

describe('support inbox admin table (WARDROBE-288)', () => {
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

  it('claims a failed admin email with a conditional sending update', async () => {
    mockDynamoSend.mockResolvedValue({});

    await claimFailedAdminEmailRetry({
      conversationId: 'conv_1',
      messageSk: 'MSG#2026-01-02T00:00:00.000Z#msg_1',
    });

    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        _op: 'Update',
        input: expect.objectContaining({
          Key: { PK: 'CONV#conv_1', SK: 'MSG#2026-01-02T00:00:00.000Z#msg_1' },
          ConditionExpression: '#author = :admin AND emailStatus = :failed',
          UpdateExpression: 'SET emailStatus = :sending, #updatedAt = :now',
          ExpressionAttributeValues: expect.objectContaining({
            ':sending': SUPPORT_EMAIL_RETRY_CLAIM_STATUS,
            ':admin': 'admin',
            ':failed': 'failed',
          }),
        }),
      }),
    );
  });

  it('maps a lost retry claim to 409 not_retryable', async () => {
    const error = new Error('Conditional check failed');
    error.name = 'ConditionalCheckFailedException';
    mockDynamoSend.mockRejectedValue(error);

    await expect(
      claimFailedAdminEmailRetry({
        conversationId: 'conv_1',
        messageSk: 'MSG#2026-01-02T00:00:00.000Z#msg_1',
      }),
    ).rejects.toBeInstanceOf(SupportNotRetryableError);
  });

  it('skips META lastEmailStatus when retrying an older message', async () => {
    mockDynamoSend.mockResolvedValue({});

    await updateMessageEmailStatus({
      conversationId: 'conv_1',
      messageSk: 'MSG#2026-01-01T00:00:00.000Z#msg_old',
      emailStatus: 'sent',
      conversationLastEmailStatus: false,
    });

    expect(mockDynamoSend).toHaveBeenCalledTimes(1);
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        _op: 'Update',
        input: expect.objectContaining({
          Key: {
            PK: 'CONV#conv_1',
            SK: 'MSG#2026-01-01T00:00:00.000Z#msg_old',
          },
        }),
      }),
    );
  });

  it('conditionally writes META lastEmailStatus for the latest admin message', async () => {
    mockDynamoSend.mockResolvedValue({});

    await updateMessageEmailStatus({
      conversationId: 'conv_1',
      messageSk: 'MSG#2026-01-02T00:00:00.000Z#msg_1',
      emailStatus: 'sent',
      conversationLastEmailStatus: { createdAt: '2026-01-02T00:00:00.000Z' },
    });

    expect(mockDynamoSend).toHaveBeenCalledTimes(2);
    expect(mockDynamoSend.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        _op: 'Update',
        input: expect.objectContaining({
          Key: { PK: 'CONV#conv_1', SK: 'META' },
          ConditionExpression:
            'lastMessageAuthor = :admin AND lastMessageAt = :createdAt',
          ExpressionAttributeValues: expect.objectContaining({
            ':status': 'sent',
            ':admin': 'admin',
            ':createdAt': '2026-01-02T00:00:00.000Z',
          }),
        }),
      }),
    );
  });

  it('leaves META lastEmailStatus in place when the latest-admin condition fails', async () => {
    const error = new Error('Conditional check failed');
    error.name = 'ConditionalCheckFailedException';
    mockDynamoSend
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(error);

    await expect(
      updateMessageEmailStatus({
        conversationId: 'conv_1',
        messageSk: 'MSG#2026-01-02T00:00:00.000Z#msg_1',
        emailStatus: 'sent',
        conversationLastEmailStatus: { createdAt: '2026-01-02T00:00:00.000Z' },
      }),
    ).resolves.toBeUndefined();
  });

  it('maps a DynamoDB cursor ValidationException to 400 validation', async () => {
    const error = new Error('The provided starting key is invalid');
    error.name = 'ValidationException';
    mockDynamoSend.mockRejectedValue(error);

    await expect(
      listConversationsByStatus({
        status: 'open',
        limit: 50,
        exclusiveStartKey: { foo: 1 },
      }),
    ).rejects.toBeInstanceOf(SupportValidationError);
  });
});
