import { DynamoItem } from '../../src/shared/types';
import {
  clothingCoverImageKey,
  firstItemCoverImageKey,
  wardrobeOwnImageKey,
} from '../../src/functions/wardrobes/cover';

const USER_ID = 'firebase-uid-owner';
const WARDROBE_ID = 'wd_abc123xyz0';
const ORIGINAL_KEY = `users/${USER_ID}/uploads/photo.jpg`;
const PROCESSED_KEY = `users/${USER_ID}/items/item_first00001/processed.png`;

function item(overrides: Partial<DynamoItem> = {}): DynamoItem {
  return {
    PK: `WARDROBE#${WARDROBE_ID}`,
    SK: 'ITEM#item_first00001',
    entityType: 'ITEM',
    userId: USER_ID,
    wardrobeId: WARDROBE_ID,
    itemId: 'item_first00001',
    createdAt: '2026-09-03T18:45:00.000Z',
    updatedAt: '2026-09-03T18:45:00.000Z',
    ...overrides,
  };
}

describe('wardrobe cover helpers (WARDROBE-178)', () => {
  describe('wardrobeOwnImageKey', () => {
    it('prefers coverImageKey over imageKey and item-style keys', () => {
      expect(
        wardrobeOwnImageKey(
          item({
            entityType: 'WARDROBE',
            coverImageKey: 'users/uid/wardrobes/cover.jpg',
            imageKey: 'users/uid/wardrobes/other.jpg',
            processedKey: PROCESSED_KEY,
            originalKey: ORIGINAL_KEY,
          }),
        ),
      ).toBe('users/uid/wardrobes/cover.jpg');
    });

    it('reads a nested image map when top-level keys are absent', () => {
      expect(
        wardrobeOwnImageKey(
          item({
            entityType: 'WARDROBE',
            image: { processedKey: PROCESSED_KEY, originalKey: ORIGINAL_KEY },
          }),
        ),
      ).toBe(PROCESSED_KEY);
    });

    it('returns undefined when the wardrobe has no image fields', () => {
      expect(
        wardrobeOwnImageKey(
          item({
            entityType: 'WARDROBE',
            originalKey: undefined,
            processedKey: undefined,
          }),
        ),
      ).toBeUndefined();
    });
  });

  describe('clothingCoverImageKey', () => {
    it('prefers processedKey then originalKey', () => {
      expect(
        clothingCoverImageKey(
          item({ processedKey: PROCESSED_KEY, originalKey: ORIGINAL_KEY }),
        ),
      ).toBe(PROCESSED_KEY);
      expect(clothingCoverImageKey(item({ originalKey: ORIGINAL_KEY }))).toBe(
        ORIGINAL_KEY,
      );
      expect(clothingCoverImageKey(item({ originalKey: undefined }))).toBeUndefined();
    });
  });

  describe('firstItemCoverImageKey', () => {
    it('picks the earliest createdAt, then itemId', () => {
      const later = item({
        SK: 'ITEM#item_later00002',
        itemId: 'item_later00002',
        createdAt: '2026-09-04T10:00:00.000Z',
        originalKey: 'users/uid/uploads/later.jpg',
      });
      const earlier = item({
        SK: 'ITEM#item_early00001',
        itemId: 'item_early00001',
        createdAt: '2026-09-03T08:00:00.000Z',
        originalKey: 'users/uid/uploads/early.jpg',
      });
      const sameTimeLaterId = item({
        SK: 'ITEM#item_z999999999',
        itemId: 'item_z999999999',
        createdAt: '2026-09-03T08:00:00.000Z',
        originalKey: 'users/uid/uploads/tie.jpg',
      });

      expect(
        firstItemCoverImageKey(
          [later, sameTimeLaterId, earlier],
          USER_ID,
          WARDROBE_ID,
        ),
      ).toBe('users/uid/uploads/early.jpg');
    });

    it('skips an imageless older item and uses the next photo', () => {
      expect(
        firstItemCoverImageKey(
          [
            item({
              SK: 'ITEM#item_empty00001',
              itemId: 'item_empty00001',
              createdAt: '2026-09-01T00:00:00.000Z',
              originalKey: undefined,
            }),
            item({
              SK: 'ITEM#item_photo00002',
              itemId: 'item_photo00002',
              createdAt: '2026-09-02T00:00:00.000Z',
              originalKey: ORIGINAL_KEY,
            }),
          ],
          USER_ID,
          WARDROBE_ID,
        ),
      ).toBe(ORIGINAL_KEY);
    });

    it('ignores other-user and non-item rows', () => {
      expect(
        firstItemCoverImageKey(
          [
            item({
              entityType: 'OUTFIT',
              originalKey: 'users/uid/uploads/outfit.jpg',
            }),
            item({
              userId: 'someone-else',
              originalKey: 'users/else/uploads/stolen.jpg',
            }),
          ],
          USER_ID,
          WARDROBE_ID,
        ),
      ).toBeUndefined();
    });
  });
});
