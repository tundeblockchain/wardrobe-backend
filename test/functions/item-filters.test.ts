import { itemMatchesFilters, parseItemListFilters } from '../../src/functions/items/filters';
import { AppError } from '../../src/shared/errors';
import { DynamoItem } from '../../src/shared/types';

function item(overrides: Partial<DynamoItem> = {}): DynamoItem {
  return {
    PK: 'WARDROBE#wd_1',
    SK: 'ITEM#item_1',
    entityType: 'ITEM',
    userId: 'uid',
    wardrobeId: 'wd_1',
    itemId: 'item_1',
    name: 'Shirt',
    category: 'TOP',
    subcategory: 'TSHIRT',
    colours: ['BLACK'],
    createdAt: '2026-09-03T18:45:00.000Z',
    updatedAt: '2026-09-03T18:45:00.000Z',
    ...overrides,
  };
}

describe('item list filters (WARDROBE-21)', () => {
  describe('parseItemListFilters', () => {
    it('returns empty filters when the query is missing', () => {
      expect(parseItemListFilters(undefined)).toEqual({});
      expect(parseItemListFilters({})).toEqual({});
    });

    it('parses controlled category, colour, and subcategory tokens', () => {
      expect(
        parseItemListFilters({
          category: 'TOP',
          colour: 'BLACK',
          subcategory: 'TSHIRT',
          userId: 'spoofed',
        }),
      ).toEqual({
        category: 'TOP',
        colour: 'BLACK',
        subcategory: 'TSHIRT',
      });
    });

    it('treats blank query values as omitted', () => {
      expect(
        parseItemListFilters({ category: '', colour: undefined }),
      ).toEqual({});
    });

    it('throws VALIDATION_ERROR for unknown tokens', () => {
      expect(() => parseItemListFilters({ category: 'HAT' })).toThrow(AppError);
      expect(() => parseItemListFilters({ colour: 'TURQUOISE' })).toThrow(
        AppError,
      );
      expect(() => parseItemListFilters({ subcategory: 'CAP' })).toThrow(
        AppError,
      );
    });
  });

  describe('itemMatchesFilters', () => {
    it('matches with no filters', () => {
      expect(itemMatchesFilters(item(), {})).toBe(true);
    });

    it('matches user category or ai.detectedCategory', () => {
      expect(itemMatchesFilters(item(), { category: 'TOP' })).toBe(true);
      expect(itemMatchesFilters(item(), { category: 'BOTTOM' })).toBe(false);
      expect(
        itemMatchesFilters(
          item({
            category: 'BOTTOM',
            ai: { detectedCategory: 'TOP' },
          }),
          { category: 'TOP' },
        ),
      ).toBe(true);
    });

    it('matches user colours or ai.detectedColours', () => {
      expect(itemMatchesFilters(item(), { colour: 'BLACK' })).toBe(true);
      expect(itemMatchesFilters(item(), { colour: 'NAVY' })).toBe(false);
      expect(
        itemMatchesFilters(
          item({
            colours: ['WHITE'],
            ai: { detectedColours: ['NAVY'] },
          }),
          { colour: 'NAVY' },
        ),
      ).toBe(true);
    });

    it('matches user subcategory or ai.detectedSubcategory', () => {
      expect(itemMatchesFilters(item(), { subcategory: 'TSHIRT' })).toBe(true);
      expect(itemMatchesFilters(item(), { subcategory: 'SHIRT' })).toBe(false);
      expect(
        itemMatchesFilters(
          item({
            subcategory: 'SHIRT',
            ai: { detectedSubcategory: 'TSHIRT' },
          }),
          { subcategory: 'TSHIRT' },
        ),
      ).toBe(true);
    });

    it('requires every supplied filter to match', () => {
      expect(
        itemMatchesFilters(item(), {
          category: 'TOP',
          colour: 'RED',
        }),
      ).toBe(false);
    });
  });
});
