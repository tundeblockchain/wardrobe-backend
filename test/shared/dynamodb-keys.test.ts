import { keys } from '../../src/shared/dynamodb';

describe('DynamoDB key design (backend.md §16–17)', () => {
  it('models user profile and wardrobe access under USER#', () => {
    expect(keys.userPk('firebase-uid-123')).toBe('USER#firebase-uid-123');
    expect(keys.profileSk).toBe('PROFILE');
    expect(keys.wardrobeSk('wd_abc123')).toBe('WARDROBE#wd_abc123');
  });

  it('models item and outfit access under WARDROBE#', () => {
    expect(keys.wardrobePk('wd_abc123')).toBe('WARDROBE#wd_abc123');
    expect(keys.itemSk('item_xyz123')).toBe('ITEM#item_xyz123');
    expect(keys.outfitSk('outfit_123')).toBe('OUTFIT#outfit_123');
  });
});
