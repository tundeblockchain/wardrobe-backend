import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { isConditionalCheckFailed, isTransactionCanceled } from '../../shared/dynamodb';
import { Errors } from '../../shared/errors';
import { nowIso } from '../../shared/ids';
import {
  SUPPORT_TABLE_NAME_ENV,
  type SupportConversationStatus,
  type SupportEmailStatus,
  type SupportMessageAuthor,
} from '../../shared/support-inbox-names';
import { SupportNotFoundError } from './http';
import { keys, STATUS_LAST_MESSAGE_INDEX } from './keys';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export function supportInboxTableName(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const name = env[SUPPORT_TABLE_NAME_ENV]?.trim();
  if (!name) {
    throw Errors.internal('SUPPORT_TABLE_NAME is not configured.');
  }
  return name;
}

export async function incrementSupportCounter(input: {
  pk: string;
  sk: string;
  ttl: number;
  tableName?: string;
}): Promise<number> {
  const now = nowIso();
  const result = await client.send(
    new UpdateCommand({
      TableName: input.tableName ?? supportInboxTableName(),
      Key: { PK: input.pk, SK: input.sk },
      UpdateExpression:
        'ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl), #entityType = if_not_exists(#entityType, :entityType), #createdAt = if_not_exists(#createdAt, :now), #updatedAt = :now',
      ExpressionAttributeNames: {
        '#count': 'count',
        '#ttl': 'ttl',
        '#entityType': 'entityType',
        '#createdAt': 'createdAt',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':one': 1,
        ':ttl': input.ttl,
        ':entityType': 'RATE_LIMIT',
        ':now': now,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );

  const count = result.Attributes?.count;
  return typeof count === 'number' ? count : 0;
}

export async function transactPutSupportItems(
  items: Array<Record<string, unknown>>,
  tableName?: string,
): Promise<void> {
  if (items.length === 0) {
    throw Errors.internal('transactPutSupportItems requires at least one item.');
  }

  await client.send(
    new TransactWriteCommand({
      TransactItems: items.map((item) => ({
        Put: {
          TableName: tableName ?? supportInboxTableName(),
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      })),
    }),
  );
}

export async function updateMessageEmailStatus(input: {
  conversationId: string;
  messageSk: string;
  emailStatus: SupportEmailStatus;
  tableName?: string;
}): Promise<void> {
  const tableName = input.tableName ?? supportInboxTableName();
  const now = nowIso();
  await client.send(
    new UpdateCommand({
      TableName: tableName,
      Key: {
        PK: keys.conversationPk(input.conversationId),
        SK: input.messageSk,
      },
      UpdateExpression: 'SET emailStatus = :status, #updatedAt = :now',
      ExpressionAttributeNames: {
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':status': input.emailStatus,
        ':now': now,
      },
    }),
  );
  await client.send(
    new UpdateCommand({
      TableName: tableName,
      Key: {
        PK: keys.conversationPk(input.conversationId),
        SK: keys.metaSk,
      },
      UpdateExpression: 'SET lastEmailStatus = :status, #updatedAt = :now',
      ExpressionAttributeNames: {
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':status': input.emailStatus,
        ':now': now,
      },
    }),
  );
}

export async function getConversationMeta(
  conversationId: string,
  tableName?: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName ?? supportInboxTableName(),
      Key: {
        PK: keys.conversationPk(conversationId),
        SK: keys.metaSk,
      },
    }),
  );
  return result.Item;
}

export async function requireConversationMeta(
  conversationId: string,
  tableName?: string,
): Promise<Record<string, unknown>> {
  const item = await getConversationMeta(conversationId, tableName);
  if (!item) {
    throw new SupportNotFoundError();
  }
  return item;
}

export async function queryConversationMessages(
  conversationId: string,
  tableName?: string,
): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName ?? supportInboxTableName(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': keys.conversationPk(conversationId),
          ':sk': keys.messageSkPrefix,
        },
        ScanIndexForward: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    items.push(...((result.Items ?? []) as Array<Record<string, unknown>>));
    exclusiveStartKey = result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (exclusiveStartKey);

  return items;
}

export async function findConversationMessage(input: {
  conversationId: string;
  messageId: string;
  tableName?: string;
}): Promise<Record<string, unknown> | undefined> {
  const messages = await queryConversationMessages(
    input.conversationId,
    input.tableName,
  );
  return messages.find((item) => item.messageId === input.messageId);
}

export async function requireConversationMessage(input: {
  conversationId: string;
  messageId: string;
  tableName?: string;
}): Promise<Record<string, unknown>> {
  await requireConversationMeta(input.conversationId, input.tableName);
  const message = await findConversationMessage(input);
  if (!message) {
    throw new SupportNotFoundError();
  }
  return message;
}

export interface ListConversationsByStatusInput {
  status: SupportConversationStatus;
  limit: number;
  exclusiveStartKey?: Record<string, unknown>;
  tableName?: string;
}

export interface ListConversationsByStatusResult {
  items: Array<Record<string, unknown>>;
  lastEvaluatedKey?: Record<string, unknown>;
}

export async function listConversationsByStatus(
  input: ListConversationsByStatusInput,
): Promise<ListConversationsByStatusResult> {
  const result = await client.send(
    new QueryCommand({
      TableName: input.tableName ?? supportInboxTableName(),
      IndexName: STATUS_LAST_MESSAGE_INDEX,
      KeyConditionExpression: '#status = :status',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':status': input.status,
      },
      ScanIndexForward: false,
      Limit: input.limit,
      ...(input.exclusiveStartKey
        ? { ExclusiveStartKey: input.exclusiveStartKey }
        : {}),
    }),
  );

  return {
    items: (result.Items ?? []) as Array<Record<string, unknown>>,
    lastEvaluatedKey: result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined,
  };
}

export async function transactPutAdminReply(input: {
  conversationId: string;
  message: Record<string, unknown>;
  status: SupportConversationStatus;
  lastMessageAt: string;
  lastMessagePreview: string;
  lastMessageAuthor: SupportMessageAuthor;
  tableName?: string;
}): Promise<void> {
  const tableName = input.tableName ?? supportInboxTableName();
  const now = nowIso();
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: input.message,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Update: {
              TableName: tableName,
              Key: {
                PK: keys.conversationPk(input.conversationId),
                SK: keys.metaSk,
              },
              UpdateExpression:
                'SET #status = :status, lastMessageAt = :lastMessageAt, lastMessagePreview = :preview, lastMessageAuthor = :author, #updatedAt = :now',
              ExpressionAttributeNames: {
                '#status': 'status',
                '#updatedAt': 'updatedAt',
              },
              ExpressionAttributeValues: {
                ':status': input.status,
                ':lastMessageAt': input.lastMessageAt,
                ':preview': input.lastMessagePreview,
                ':author': input.lastMessageAuthor,
                ':now': now,
              },
              ConditionExpression: 'attribute_exists(PK)',
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (isTransactionCanceled(error) || isConditionalCheckFailed(error)) {
      throw new SupportNotFoundError();
    }
    throw error;
  }
}

export async function closeConversation(
  conversationId: string,
  tableName?: string,
): Promise<Record<string, unknown>> {
  try {
    const result = await client.send(
      new UpdateCommand({
        TableName: tableName ?? supportInboxTableName(),
        Key: {
          PK: keys.conversationPk(conversationId),
          SK: keys.metaSk,
        },
        UpdateExpression: 'SET #status = :closed, #updatedAt = :now',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':closed': 'closed',
          ':now': nowIso(),
        },
        ConditionExpression: 'attribute_exists(PK)',
        ReturnValues: 'ALL_NEW',
      }),
    );
    return result.Attributes ?? { conversationId, status: 'closed' };
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      throw new SupportNotFoundError();
    }
    throw error;
  }
}
