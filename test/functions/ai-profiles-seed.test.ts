import { keys } from '../../src/shared/dynamodb';
import { DynamoItem } from '../../src/shared/types';
import {
  GENERIC_MODEL_CATALOG_CREATED_AT,
  genericModelCatalog,
} from '../../src/functions/ai-profiles/catalog';
import { buildGenericModelProfile } from '../../src/functions/ai-profiles/model';
import {
  catalogRowMatches,
  seedGenericModels,
} from '../../src/functions/ai-profiles/seed';

describe('seedGenericModels (WARDROBE-45)', () => {
  const catalog = genericModelCatalog();

  function catalogItem(
    entry: (typeof catalog)[number],
    overrides: Partial<DynamoItem> = {},
  ): DynamoItem {
    return {
      ...buildGenericModelProfile({
        aiProfileId: entry.aiProfileId,
        referenceImages: entry.referenceImages,
        status: entry.status,
        label: entry.label,
        createdAt: GENERIC_MODEL_CATALOG_CREATED_AT,
        updatedAt: GENERIC_MODEL_CATALOG_CREATED_AT,
      }),
      ...overrides,
    };
  }

  it('creates READY rows for an empty table', async () => {
    const store = new Map<string, DynamoItem>();
    const putItem = jest.fn(async (item: DynamoItem) => {
      store.set(`${item.PK}|${item.SK}`, item);
    });
    const getItem = jest.fn(async (pk: string, sk: string) => store.get(`${pk}|${sk}`));

    const results = await seedGenericModels({ getItem, putItem });

    expect(results).toHaveLength(catalog.length);
    expect(results.every((row) => row.action === 'created')).toBe(true);
    expect(putItem).toHaveBeenCalledTimes(catalog.length);

    for (const entry of catalog) {
      const item = store.get(
        `${keys.genericModelPk()}|${keys.aiProfileSk(entry.aiProfileId)}`,
      );
      expect(item).toEqual(
        expect.objectContaining({
          PK: 'AIPROFILE#GENERIC_MODEL',
          GSI1PK: 'TYPE#GENERIC_MODEL',
          type: 'GENERIC_MODEL',
          status: 'READY',
          userId: 'SYSTEM',
          label: entry.label,
          referenceImages: entry.referenceImages,
          createdAt: GENERIC_MODEL_CATALOG_CREATED_AT,
          updatedAt: GENERIC_MODEL_CATALOG_CREATED_AT,
        }),
      );
    }
  });

  it('is idempotent when catalog rows already match', async () => {
    const store = new Map<string, DynamoItem>();
    for (const entry of catalog) {
      const item = catalogItem(entry);
      store.set(`${item.PK}|${item.SK}`, item);
    }
    const putItem = jest.fn();
    const getItem = jest.fn(async (pk: string, sk: string) => store.get(`${pk}|${sk}`));

    const results = await seedGenericModels({ getItem, putItem });

    expect(results.every((row) => row.action === 'unchanged')).toBe(true);
    expect(putItem).not.toHaveBeenCalled();
  });

  it('backfills missing GSI keys and preserves createdAt', async () => {
    const first = catalog[0];
    const stale = catalogItem(first);
    delete stale.GSI1PK;
    delete stale.GSI1SK;
    stale.createdAt = '2026-01-01T00:00:00.000Z';

    const store = new Map<string, DynamoItem>([[`${stale.PK}|${stale.SK}`, stale]]);
    const putItem = jest.fn(async (item: DynamoItem) => {
      store.set(`${item.PK}|${item.SK}`, item);
    });
    const getItem = jest.fn(async (pk: string, sk: string) => store.get(`${pk}|${sk}`));

    const results = await seedGenericModels({
      getItem,
      putItem,
      nowIso: () => '2026-09-06T12:00:00.000Z',
    });

    const updated = results.find((row) => row.aiProfileId === first.aiProfileId);
    expect(updated?.action).toBe('updated');
    expect(results.filter((row) => row.action === 'created')).toHaveLength(
      catalog.length - 1,
    );

    const written = store.get(`${stale.PK}|${stale.SK}`);
    expect(written?.GSI1PK).toBe('TYPE#GENERIC_MODEL');
    expect(written?.GSI1SK).toBe(`AIPROFILE#${first.aiProfileId}`);
    expect(written?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(written?.updatedAt).toBe('2026-09-06T12:00:00.000Z');
  });

  it('detects catalog row mismatches', () => {
    const entry = catalog[0];
    const item = catalogItem(entry);
    expect(catalogRowMatches(item, item)).toBe(true);
    expect(catalogRowMatches(undefined, item)).toBe(false);
    expect(
      catalogRowMatches({ ...item, referenceImages: ['other.jpg'] }, item),
    ).toBe(false);
    expect(catalogRowMatches({ ...item, GSI1PK: undefined }, item)).toBe(false);
  });
});
