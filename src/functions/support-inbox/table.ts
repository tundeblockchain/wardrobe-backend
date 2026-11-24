import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { isConditionalCheckFailed, isTransactionCanceled } from '../../shared/dynamodb';
import { Errors } from '../../shared/errors';
import { nowIso } from '../../shared/ids';
import {
  SUPPORT_EMAIL_RETRY_CLAIM_STATUS,
  SUPPORT_TABLE_NAME_ENV,
  supportEmailRetryClaimStaleBefore,
  type SupportConversationStatus,
  type SupportEmailStatus,
  type SupportMessageAuthor,
  type SupportPushStatus,
} from '../../shared/support-inbox-names';
import {
  SupportNotFoundError,
  SupportNotRetryableError,
  SupportValidationError,
} from './http';
import { keys, STATUS_LAST_MESSAGE_INDEX, UID_LAST_MESSAGE_INDEX } from './keys';

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

export interface ClaimFailedAdminEmailRetryInput {
  conversationId: string;
  messageSk: string;
  tableName?: string;
}

/**
 * Atomically claim a failed (or stale sending) admin message for retry-email.
 * Condition: author=admin AND (emailStatus=failed OR (sending AND
 * updatedAt older than SUPPORT_EMAIL_RETRY_CLAIM_STALE_MS)).
 * Sets emailStatus=sending and bumps updatedAt so a concurrent takeover loses.
 * Conditional-check failure => 409 not_retryable.
 */
export async function claimFailedAdminEmailRetry(
  input: ClaimFailedAdminEmailRetryInput,
): Promise<void> {
  const now = nowIso();
  try {
    await client.send(
      new UpdateCommand({
        TableName: input.tableName ?? supportInboxTableName(),
        Key: {
          PK: keys.conversationPk(input.conversationId),
          SK: input.messageSk,
        },
        UpdateExpression: 'SET emailStatus = :sending, #updatedAt = :now',
        ConditionExpression:
          '#author = :admin AND (emailStatus = :failed OR (emailStatus = :sending AND #updatedAt < :staleBefore))',
        ExpressionAttributeNames: {
          '#author': 'author',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':sending': SUPPORT_EMAIL_RETRY_CLAIM_STATUS,
          ':admin': 'admin',
          ':failed': 'failed',
          ':now': now,
          ':staleBefore': supportEmailRetryClaimStaleBefore(now),
        },
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      throw new SupportNotRetryableError();
    }
    throw error;
  }
}

export async function updateMessageEmailStatus(input: {
  conversationId: string;
  messageSk: string;
  emailStatus: SupportEmailStatus;
  /**
   * Reply path omits this and always writes META lastEmailStatus.
   * Retry of the latest admin message passes `{ createdAt }` (conditional).
   * Retry of an older admin message passes `false` (META untouched).
   */
  conversationLastEmailStatus?: false | { createdAt: string };
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

  if (input.conversationLastEmailStatus === false) {
    return;
  }

  const metaValues: Record<string, unknown> = {
    ':status': input.emailStatus,
    ':now': now,
  };
  let conditionExpression: string | undefined;
  if (input.conversationLastEmailStatus) {
    conditionExpression =
      'lastMessageAuthor = :admin AND lastMessageAt = :createdAt';
    metaValues[':admin'] = 'admin';
    metaValues[':createdAt'] = input.conversationLastEmailStatus.createdAt;
  }

  try {
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
        ExpressionAttributeValues: metaValues,
        ...(conditionExpression
          ? { ConditionExpression: conditionExpression }
          : {}),
      }),
    );
  } catch (error) {
    if (conditionExpression && isConditionalCheckFailed(error)) {
      return;
    }
    throw error;
  }
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
  try {
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
  } catch (error) {
    if (
      input.exclusiveStartKey &&
      error instanceof Error &&
      error.name === 'ValidationException'
    ) {
      throw new SupportValidationError({ cursor: 'must be a valid cursor' });
    }
    throw error;
  }
}

export async function transactPutAdminReply(input: {
  conversationId: string;
  message: Record<string, unknown>;
  status: SupportConversationStatus;
  lastMessageAt: string;
  lastMessagePreview: string;
  lastMessageAuthor: SupportMessageAuthor;
  lastAdminMessageId?: string;
  lastAdminMessageAt?: string;
  expectedUid?: string;
  tableName?: string;
}): Promise<void> {
  const tableName = input.tableName ?? supportInboxTableName();
  const now = nowIso();
  const lastAdminMessageId =
    input.lastAdminMessageId ??
    (typeof input.message.messageId === 'string'
      ? input.message.messageId
      : undefined);
  const expressionAttributeValues: Record<string, unknown> = {
    ':status': input.status,
    ':lastMessageAt': input.lastMessageAt,
    ':preview': input.lastMessagePreview,
    ':author': input.lastMessageAuthor,
    ':now': now,
  };
  let updateExpression =
    'SET #status = :status, lastMessageAt = :lastMessageAt, lastMessagePreview = :preview, lastMessageAuthor = :author, #updatedAt = :now';
  if (lastAdminMessageId) {
    updateExpression += ', lastAdminMessageId = :lastAdminMessageId';
    expressionAttributeValues[':lastAdminMessageId'] = lastAdminMessageId;
  }
  if (input.lastAdminMessageAt) {
    updateExpression += ', lastAdminMessageAt = :lastAdminMessageAt';
    expressionAttributeValues[':lastAdminMessageAt'] = input.lastAdminMessageAt;
  }
  const conditionParts = ['attribute_exists(PK)'];
  if (input.expectedUid) {
    conditionParts.push('#uid = :expectedUid');
    expressionAttributeValues[':expectedUid'] = input.expectedUid;
  }
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
              UpdateExpression: updateExpression,
              ExpressionAttributeNames: {
                '#status': 'status',
                '#updatedAt': 'updatedAt',
                ...(input.expectedUid ? { '#uid': 'uid' } : {}),
              },
              ExpressionAttributeValues: expressionAttributeValues,
              ConditionExpression: conditionParts.join(' AND '),
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

export async function updateConversationLastReadAt(input: {
  conversationId: string;
  uid: string;
  lastReadAt?: string;
  tableName?: string;
}): Promise<void> {
  const lastReadAt = input.lastReadAt ?? nowIso();
  try {
    await client.send(
      new UpdateCommand({
        TableName: input.tableName ?? supportInboxTableName(),
        Key: {
          PK: keys.conversationPk(input.conversationId),
          SK: keys.metaSk,
        },
        UpdateExpression: 'SET lastReadAt = :lastReadAt, #updatedAt = :lastReadAt',
        ExpressionAttributeNames: {
          '#updatedAt': 'updatedAt',
          '#uid': 'uid',
        },
        ExpressionAttributeValues: {
          ':lastReadAt': lastReadAt,
          ':uid': input.uid,
        },
        ConditionExpression: 'attribute_exists(PK) AND #uid = :uid',
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      throw new SupportNotFoundError();
    }
    throw error;
  }
}

export async function updateMessagePushStatus(input: {
  conversationId: string;
  messageSk: string;
  pushStatus: SupportPushStatus;
  tableName?: string;
}): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: input.tableName ?? supportInboxTableName(),
      Key: {
        PK: keys.conversationPk(input.conversationId),
        SK: input.messageSk,
      },
      UpdateExpression: 'SET pushStatus = :status, #updatedAt = :now',
      ExpressionAttributeNames: {
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':status': input.pushStatus,
        ':now': nowIso(),
      },
    }),
  );
}

export async function listConversationsByUid(input: {
  uid: string;
  limit: number;
  exclusiveStartKey?: Record<string, unknown>;
  tableName?: string;
}): Promise<ListConversationsByStatusResult> {
  try {
    const result = await client.send(
      new QueryCommand({
        TableName: input.tableName ?? supportInboxTableName(),
        IndexName: UID_LAST_MESSAGE_INDEX,
        KeyConditionExpression: '#uid = :uid',
        ExpressionAttributeNames: {
          '#uid': 'uid',
        },
        ExpressionAttributeValues: {
          ':uid': input.uid,
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
  } catch (error) {
    if (isDynamoValidationException(error)) {
      throw new SupportValidationError({ cursor: 'must be a valid cursor' });
    }
    throw error;
  }
}

export async function getSupportItem(
  pk: string,
  sk: string,
  tableName?: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName ?? supportInboxTableName(),
      Key: { PK: pk, SK: sk },
    }),
  );
  return result.Item;
}

export async function putSupportItem(
  item: Record<string, unknown>,
  tableName?: string,
): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: tableName ?? supportInboxTableName(),
      Item: item,
    }),
  );
}

export async function deleteSupportItem(
  pk: string,
  sk: string,
  tableName?: string,
): Promise<void> {
  await client.send(
    new DeleteCommand({
      TableName: tableName ?? supportInboxTableName(),
      Key: { PK: pk, SK: sk },
    }),
  );
}

export async function queryDevicesByUid(
  uid: string,
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
          ':pk': keys.devicePk(uid),
          ':sk': keys.deviceSkPrefix,
        },
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

function isDynamoValidationException(error: unknown): boolean {
  return error instanceof Error && error.name === 'ValidationException';
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
