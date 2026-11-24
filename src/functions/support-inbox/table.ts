import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { Errors } from '../../shared/errors';
import { nowIso } from '../../shared/ids';
import { SUPPORT_TABLE_NAME_ENV } from '../../shared/support-inbox-names';

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
