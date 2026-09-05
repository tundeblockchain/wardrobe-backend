import { DynamoItem } from '../../src/shared/types';
import {
  colourCompatibility,
  createRuleBasedRecommender,
  MAX_RECOMMENDATIONS,
  recommendFromReadyItems,
  RecommendableItem,
  resolveColours,
  resolveSlot,
  toRecommendableItem,
} from '../../src/functions/recommendations/strategy';

function dynamoItem(overrides: Partial<DynamoItem> = {}): DynamoItem {
  return {
    PK: 'WARDROBE#wd_1',
    SK: 'ITEM#item_1',
    entityType: 'ITEM',
    userId: 'uid',
    wardrobeId: 'wd_1',
    itemId: 'item_1',
    name: 'Black T-Shirt',
    category: 'TOP',
    colours: ['BLACK'],
    processingStatus: 'READY',
    createdAt: '2026-09-03T18:45:00.000Z',
    updatedAt: '2026-09-03T18:45:00.000Z',
    ...overrides,
  };
}

function item(
  itemId: string,
  slot: RecommendableItem['slot'],
  colours: RecommendableItem['colours'] = [],
): RecommendableItem {
  return { itemId, name: itemId, slot, colours };
}

describe('toRecommendableItem / AI fallbacks (WARDROBE-23)', () => {
  it('prefers ai.detectedCategory over the user category', () => {
    const ready = dynamoItem({
      category: 'BOTTOM',
      ai: { detectedCategory: 'TOP', detectedColours: ['NAVY'] },
    });
    expect(resolveSlot(ready)).toBe('TOP');
    expect(toRecommendableItem(ready)?.slot).toBe('TOP');
  });

  it('falls back to the user category when AI metadata is missing', () => {
    expect(resolveSlot(dynamoItem({ category: 'SHOES' }))).toBe('SHOES');
  });

  it('prefers ai.detectedColours over user colours', () => {
    expect(
      resolveColours(
        dynamoItem({
          colours: ['RED'],
          ai: { detectedColours: ['NAVY', 'CREAM'] },
        }),
      ),
    ).toEqual(['NAVY', 'CREAM']);
  });

  it('falls back to user colours when AI colours are empty', () => {
    expect(
      resolveColours(
        dynamoItem({
          colours: ['BLACK'],
          ai: { detectedCategory: 'TOP', detectedColours: [] },
        }),
      ),
    ).toEqual(['BLACK']);
  });

  it('skips non-READY items', () => {
    expect(toRecommendableItem(dynamoItem({ processingStatus: 'PENDING' }))).toBeUndefined();
    expect(toRecommendableItem(dynamoItem({ processingStatus: 'PROCESSING' }))).toBeUndefined();
    expect(toRecommendableItem(dynamoItem({ processingStatus: 'FAILED' }))).toBeUndefined();
  });

  it('skips items without a controlled slot', () => {
    expect(
      toRecommendableItem(dynamoItem({ category: 'HAT', ai: {} })),
    ).toBeUndefined();
  });
});

describe('recommendFromReadyItems', () => {
  it('returns an empty list when items are insufficient for an outfit', () => {
    expect(recommendFromReadyItems([])).toEqual([]);
    expect(recommendFromReadyItems([item('item_top', 'TOP', ['BLACK'])])).toEqual([]);
    expect(
      recommendFromReadyItems([
        item('item_top', 'TOP', ['BLACK']),
        item('item_shoes', 'SHOES', ['BLACK']),
      ]),
    ).toEqual([]);
  });

  it('builds TOP+BOTTOM looks with Flutter itemId+slot items', () => {
    const recommendations = recommendFromReadyItems([
      item('item_top', 'TOP', ['NAVY']),
      item('item_bottom', 'BOTTOM', ['BEIGE']),
      item('item_shoes', 'SHOES', ['BROWN']),
    ]);

    expect(recommendations.length).toBeGreaterThan(0);
    expect(recommendations[0].items).toEqual(
      expect.arrayContaining([
        { itemId: 'item_top', slot: 'TOP' },
        { itemId: 'item_bottom', slot: 'BOTTOM' },
        { itemId: 'item_shoes', slot: 'SHOES' },
      ]),
    );
    expect(recommendations[0].name).toBe('Navy + Beige look');
  });

  it('builds DRESS looks when no TOP+BOTTOM pair exists', () => {
    const recommendations = recommendFromReadyItems([
      item('item_dress', 'DRESS', ['BLACK']),
      item('item_shoes', 'SHOES', ['BLACK']),
    ]);

    expect(recommendations).toEqual([
      expect.objectContaining({
        name: 'Black dress look',
        items: expect.arrayContaining([
          { itemId: 'item_dress', slot: 'DRESS' },
          { itemId: 'item_shoes', slot: 'SHOES' },
        ]),
      }),
    ]);
  });

  it('caps the number of suggestions and stays deterministic', () => {
    const items: RecommendableItem[] = [];
    for (let i = 0; i < 8; i += 1) {
      items.push(item(`item_top_${i}`, 'TOP', ['BLACK']));
      items.push(item(`item_bottom_${i}`, 'BOTTOM', ['WHITE']));
    }

    const first = recommendFromReadyItems(items);
    const second = recommendFromReadyItems(items);
    expect(first).toHaveLength(MAX_RECOMMENDATIONS);
    expect(second).toEqual(first);
  });

  it('does not persist or invent outfit ids', () => {
    const recommendations = recommendFromReadyItems([
      item('item_top', 'TOP', ['BLACK']),
      item('item_bottom', 'BOTTOM', ['GREY']),
    ]);
    expect(recommendations[0]).not.toHaveProperty('outfitId');
    expect(recommendations[0]).not.toHaveProperty('wardrobeId');
  });
});

describe('colourCompatibility', () => {
  it('scores matching and neutral pairings higher than clashes', () => {
    expect(colourCompatibility(['NAVY'], ['NAVY'])).toBe(3);
    expect(colourCompatibility(['NAVY'], ['CREAM'])).toBe(2);
    expect(colourCompatibility(['RED'], ['GREEN'])).toBe(0);
    expect(colourCompatibility([], ['RED'])).toBe(1);
  });
});

describe('createRuleBasedRecommender', () => {
  it('is injectable and does not call a vendor', async () => {
    const recommender = createRuleBasedRecommender();
    const recommendations = await recommender.recommend([
      item('item_dress', 'DRESS', ['RED']),
    ]);
    expect(recommendations[0].items).toEqual([{ itemId: 'item_dress', slot: 'DRESS' }]);
  });
});
