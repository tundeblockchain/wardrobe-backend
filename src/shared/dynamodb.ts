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
import { Errors } from './errors';
import { nowIso } from './ids';
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
  /**
   * Date-only worn-on entry under the same wardrobe PK as the outfit
   * (WARDROBE-120). SK extends `OUTFIT#{outfitId}` so list-outfits
   * (`begins_with OUTFIT#`) still works — filter `entityType === 'OUTFIT'`.
   */
  outfitWornOnSk: (outfitId: string, wornOn: string) =>
    `OUTFIT#${outfitId}#WORN#${wornOn}`,
  outfitWornOnSkPrefix: (outfitId: string) => `OUTFIT#${outfitId}#WORN#`,
  profileSk: 'PROFILE',
  /** WARDROBE-91 Superwall-verified subscription row. */
  entitlementSk: 'ENTITLEMENT',
  /**
   * WARDROBE-96 related-shopping cache (24h Dynamo TTL on `ttl`).
   * One row per owned item; fingerprint mismatch or expiry is a miss.
   */
  shoppingCacheSk: (itemId: string) => `SHOPPING#${itemId}`,
  shoppingCacheSkPrefix: 'SHOPPING#',
  /** WARDROBE-114 durable job-done inbox (30-day TTL on `ttl`). */
  eventSk: (eventId: string) => `EVENT#${eventId}`,
  eventSkPrefix: 'EVENT#',
  /** WARDROBE-114 FCM device token. */
  deviceSk: (deviceId: string) => `DEVICE#${deviceId}`,
  deviceSkPrefix: 'DEVICE#',
  /**
   * WARDROBE-126 share-link token (public GET + owner revoke).
   * Canonical row is `SHARE#{token}` / `SHARE`. Owner wipe uses sparse GSI1
   * `SHARE#USER#{uid}` / `SHARE#{token}` (does not collide with GENERIC_MODEL).
   */
  sharePk: (token: string) => `SHARE#${token}`,
  shareSk: 'SHARE',
  gsi1ShareUserPk: (userId: string) => `SHARE#USER#${userId}`,
  gsi1ShareSk: (token: string) => `SHARE#${token}`,
  gsi1ShareSkPrefix: 'SHARE#',
  aiProfileSk: (aiProfileId: string) => `AIPROFILE#${aiProfileId}`,
  /** Catalog partition for seeded GENERIC_MODEL rows (WARDROBE-45). */
  genericModelPk: () => 'AIPROFILE#GENERIC_MODEL',
  gsi1GenericTypePk: () => 'TYPE#GENERIC_MODEL',
  gsi1AiProfileSk: (aiProfileId: string) => `AIPROFILE#${aiProfileId}`,
  /**
   * WARDROBE-143 anonymous POST /support/contact rate-limit window.
   * PK stores a SHA-256 of the source IP — never the raw address.
   */
  rateLimitPk: (scope: string, hashedId: string) => `RATE#${scope}#${hashedId}`,
  rateLimitSk: (windowStart: number) => `WINDOW#${windowStart}`,
};

export async function putItem(item: DynamoItem): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: tableName(),
      Item: item,
    }),
  );
}

/** Idempotent create. Returns false when the PK/SK already exists. */
export async function putItemIfNotExists(item: DynamoItem): Promise<boolean> {
  try {
    await client.send(
      new PutCommand({
        TableName: tableName(),
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw error;
  }
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

export function isConditionalCheckFailed(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

/**
 * Atomic put + delete for same-table moves (WARDROBE-118).
 * Clothing items are keyed by `WARDROBE#{id}` — a wardrobe change is a
 * new partition, not an in-place attribute update.
 */
export type TransactWriteOp =
  | {
      put: {
        item: DynamoItem;
        conditionExpression?: string;
      };
    }
  | {
      delete: {
        pk: string;
        sk: string;
        conditionExpression?: string;
      };
    };

export async function transactWrite(ops: TransactWriteOp[]): Promise<void> {
  if (ops.length === 0) {
    throw Errors.internal('transactWrite requires at least one operation.');
  }
  if (ops.length > 100) {
    throw Errors.internal('transactWrite supports at most 100 operations.');
  }

  await client.send(
    new TransactWriteCommand({
      TransactItems: ops.map((op) => {
        if ('put' in op) {
          return {
            Put: {
              TableName: tableName(),
              Item: op.put.item,
              ...(op.put.conditionExpression
                ? { ConditionExpression: op.put.conditionExpression }
                : {}),
            },
          };
        }
        return {
          Delete: {
            TableName: tableName(),
            Key: { PK: op.delete.pk, SK: op.delete.sk },
            ...(op.delete.conditionExpression
              ? { ConditionExpression: op.delete.conditionExpression }
              : {}),
          },
        };
      }),
    }),
  );
}

/**
 * Atomic fixed-window counter (WARDROBE-143). ADD is safe under concurrency.
 * Returns the post-increment count. Sets `ttl` once so Dynamo expires the row.
 */
export async function incrementCounter(input: {
  pk: string;
  sk: string;
  ttl: number;
  entityType: string;
}): Promise<number> {
  const now = nowIso();
  const result = await client.send(
    new UpdateCommand({
      TableName: tableName(),
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
        ':entityType': input.entityType,
        ':now': now,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );

  const count = result.Attributes?.count;
  return typeof count === 'number' ? count : 0;
}

export async function updateAttributes(
  pk: string,
  sk: string,
  attributes: Record<string, unknown>,
  options?: {
    remove?: string[];
    conditionExpression?: string;
    extraValues?: Record<string, unknown>;
  },
): Promise<DynamoItem> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = { ...(options?.extraValues ?? {}) };
  const sets: string[] = [];

  for (const [key, value] of Object.entries(attributes)) {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    sets.push(`#${key} = :${key}`);
  }

  const remove = options?.remove ?? [];
  for (const key of remove) {
    names[`#${key}`] = key;
  }

  const clauses: string[] = [];
  if (sets.length > 0) {
    clauses.push(`SET ${sets.join(', ')}`);
  }
  if (remove.length > 0) {
    clauses.push(`REMOVE ${remove.map((key) => `#${key}`).join(', ')}`);
  }
  if (clauses.length === 0) {
    throw Errors.internal('updateAttributes requires attributes to set or remove.');
  }

  const result = await client.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { PK: pk, SK: sk },
      UpdateExpression: clauses.join(' '),
      ExpressionAttributeNames: names,
      ...(Object.keys(values).length > 0
        ? { ExpressionAttributeValues: values }
        : {}),
      ConditionExpression:
        options?.conditionExpression ?? 'attribute_exists(PK)',
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
