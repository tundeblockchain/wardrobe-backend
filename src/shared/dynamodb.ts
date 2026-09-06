import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { Errors } from './errors';
import { DynamoItem } from './types';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export function tableName(): string {
  const name = process.env.TABLE_NAME;
  if (!name) {
    throw Errors.internal('TABLE_NAME is not configured.');
  }
  return name;
}

/** Sparse GSI for listing GENERIC_MODEL AI profiles available to every user. */
export const GSI1_INDEX_NAME = 'GSI1';

export const keys = {
  userPk: (userId: string) => `USER#${userId}`,
  wardrobeSk: (wardrobeId: string) => `WARDROBE#${wardrobeId}`,
  wardrobePk: (wardrobeId: string) => `WARDROBE#${wardrobeId}`,
  itemSk: (itemId: string) => `ITEM#${itemId}`,
  outfitSk: (outfitId: string) => `OUTFIT#${outfitId}`,
  profileSk: 'PROFILE',
  aiProfileSk: (aiProfileId: string) => `AIPROFILE#${aiProfileId}`,
  /** Catalog partition for seeded GENERIC_MODEL rows (WARDROBE-45). */
  genericModelPk: () => 'AIPROFILE#GENERIC_MODEL',
  gsi1GenericTypePk: () => 'TYPE#GENERIC_MODEL',
  gsi1AiProfileSk: (aiProfileId: string) => `AIPROFILE#${aiProfileId}`,
};

export async function putItem(item: DynamoItem): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: tableName(),
      Item: item,
    }),
  );
}

export async function getItem<T extends DynamoItem>(
  pk: string,
  sk: string,
): Promise<T | undefined> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName(),
      Key: { PK: pk, SK: sk },
    }),
  );
  return result.Item as T | undefined;
}

export async function queryByPk<T extends DynamoItem>(
  pk: string,
  skPrefix?: string,
): Promise<T[]> {
  const items: T[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: skPrefix
          ? 'PK = :pk AND begins_with(SK, :sk)'
          : 'PK = :pk',
        ExpressionAttributeValues: skPrefix
          ? { ':pk': pk, ':sk': skPrefix }
          : { ':pk': pk },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    items.push(...((result.Items ?? []) as T[]));
    exclusiveStartKey = result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (exclusiveStartKey);

  return items;
}

export async function queryByGsi1<T extends DynamoItem>(
  gsi1pk: string,
  options?: { skPrefix?: string; sk?: string },
): Promise<T[]> {
  const items: T[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  const values: Record<string, unknown> = { ':pk': gsi1pk };
  let keyCondition = 'GSI1PK = :pk';

  if (options?.sk) {
    keyCondition += ' AND GSI1SK = :sk';
    values[':sk'] = options.sk;
  } else if (options?.skPrefix) {
    keyCondition += ' AND begins_with(GSI1SK, :sk)';
    values[':sk'] = options.skPrefix;
  }

  do {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName(),
        IndexName: GSI1_INDEX_NAME,
        KeyConditionExpression: keyCondition,
        ExpressionAttributeValues: values,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    items.push(...((result.Items ?? []) as T[]));
    exclusiveStartKey = result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (exclusiveStartKey);

  return items;
}

export async function deleteItem(pk: string, sk: string): Promise<void> {
  await client.send(
    new DeleteCommand({
      TableName: tableName(),
      Key: { PK: pk, SK: sk },
    }),
  );
}

export async function deleteMany(
  pairs: Array<{ pk: string; sk: string }>,
): Promise<void> {
  for (const { pk, sk } of pairs) {
    await deleteItem(pk, sk);
  }
}

export async function updateAttributes(
  pk: string,
  sk: string,
  attributes: Record<string, unknown>,
): Promise<DynamoItem> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];

  for (const [key, value] of Object.entries(attributes)) {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    sets.push(`#${key} = :${key}`);
  }

  const result = await client.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { PK: pk, SK: sk },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(PK)',
      ReturnValues: 'ALL_NEW',
    }),
  );

  return result.Attributes as DynamoItem;
}

export async function getOwnedWardrobe(
  userId: string,
  wardrobeId: string,
): Promise<DynamoItem> {
  const item = await getItem(keys.userPk(userId), keys.wardrobeSk(wardrobeId));
  if (!item || item.entityType !== 'WARDROBE') {
    throw Errors.wardrobeNotFound();
  }
  return item;
}

export async function getOwnedItem(
  userId: string,
  wardrobeId: string,
  itemId: string,
): Promise<DynamoItem> {
  await getOwnedWardrobe(userId, wardrobeId);

  const item = await getItem(keys.wardrobePk(wardrobeId), keys.itemSk(itemId));
  if (
    !item ||
    item.entityType !== 'ITEM' ||
    item.userId !== userId ||
    item.wardrobeId !== wardrobeId
  ) {
    throw Errors.itemNotFound();
  }
  return item;
}

export async function getOwnedOutfit(
  userId: string,
  wardrobeId: string,
  outfitId: string,
): Promise<DynamoItem> {
  await getOwnedWardrobe(userId, wardrobeId);

  const item = await getItem(keys.wardrobePk(wardrobeId), keys.outfitSk(outfitId));
  if (
    !item ||
    item.entityType !== 'OUTFIT' ||
    item.userId !== userId ||
    item.wardrobeId !== wardrobeId
  ) {
    throw Errors.outfitNotFound();
  }
  return item;
}

export function isAiProfileItem(
  item: DynamoItem | undefined,
): item is DynamoItem {
  return !!item && item.entityType === 'AIPROFILE';
}

export function isPersonalAiProfile(
  item: DynamoItem | undefined,
  userId: string,
): item is DynamoItem {
  return (
    isAiProfileItem(item) &&
    item.type === 'PERSONAL' &&
    item.userId === userId
  );
}

export function isGenericAiProfile(
  item: DynamoItem | undefined,
): item is DynamoItem {
  return isAiProfileItem(item) && item.type === 'GENERIC_MODEL';
}

export async function getOwnedPersonalAiProfile(
  userId: string,
  aiProfileId: string,
): Promise<DynamoItem> {
  const item = await getItem(keys.userPk(userId), keys.aiProfileSk(aiProfileId));
  if (!isPersonalAiProfile(item, userId)) {
    throw Errors.aiProfileNotFound();
  }
  return item;
}

export async function findGenericAiProfile(
  aiProfileId: string,
): Promise<DynamoItem | undefined> {
  const catalog = await getItem(
    keys.genericModelPk(),
    keys.aiProfileSk(aiProfileId),
  );
  if (isGenericAiProfile(catalog)) {
    return catalog;
  }

  const fromGsi = await queryByGsi1(keys.gsi1GenericTypePk(), {
    sk: keys.gsi1AiProfileSk(aiProfileId),
  });
  return fromGsi.find(isGenericAiProfile);
}

/**
 * PERSONAL: owner-only (lookup under the caller's USER#).
 * GENERIC_MODEL: any authenticated user (catalog PK, then GSI1).
 */
export async function getReadableAiProfile(
  userId: string,
  aiProfileId: string,
): Promise<DynamoItem> {
  const personal = await getItem(
    keys.userPk(userId),
    keys.aiProfileSk(aiProfileId),
  );
  if (isPersonalAiProfile(personal, userId)) {
    return personal;
  }

  const generic = await findGenericAiProfile(aiProfileId);
  if (generic) {
    return generic;
  }

  throw Errors.aiProfileNotFound();
}
