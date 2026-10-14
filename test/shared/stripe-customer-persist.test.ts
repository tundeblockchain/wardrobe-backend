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
  PutCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Put',
    input,
  })),
  QueryCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Query',
    input,
  })),
  DeleteCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Delete',
    input,
  })),
  BatchWriteCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'BatchWrite',
    input,
  })),
  ScanCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'Scan',
    input,
  })),
  TransactWriteCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'TransactWrite',
    input,
  })),
}));

import { setStripeCustomerIdIfAbsent } from '../../src/shared/dynamodb';

describe('setStripeCustomerIdIfAbsent (WARDROBE-189)', () => {
  const previousTable = process.env.TABLE_NAME;

  beforeEach(() => {
    mockDynamoSend.mockReset();
    process.env.TABLE_NAME = 'wardrobe-app-test';
  });

  afterAll(() => {
    if (previousTable === undefined) {
      delete process.env.TABLE_NAME;
    } else {
      process.env.TABLE_NAME = previousTable;
    }
  });

  it('conditionally writes stripeCustomerId on the uid PROFILE record', async () => {
    mockDynamoSend.mockResolvedValue({});

    await expect(
      setStripeCustomerIdIfAbsent('firebase-uid-owner', 'cus_123'),
    ).resolves.toBe(true);

    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        _op: 'Update',
        input: expect.objectContaining({
          Key: { PK: 'USER#firebase-uid-owner', SK: 'PROFILE' },
          ConditionExpression: 'attribute_not_exists(stripeCustomerId)',
          ExpressionAttributeValues: expect.objectContaining({
            ':stripeCustomerId': 'cus_123',
            ':entityType': 'PROFILE',
            ':userId': 'firebase-uid-owner',
          }),
        }),
      }),
    );
  });

  it('returns false on ConditionalCheckFailedException so the caller can re-read', async () => {
    const error = new Error(' Conditional check failed');
    error.name = 'ConditionalCheckFailedException';
    mockDynamoSend.mockRejectedValue(error);

    await expect(
      setStripeCustomerIdIfAbsent('firebase-uid-owner', 'cus_loser'),
    ).resolves.toBe(false);
  });
});
