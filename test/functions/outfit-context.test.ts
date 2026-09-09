import {
  buildTryOnPrompt,
  composeOutfitTryOn,
  formatGarment,
  garmentFromClothingItem,
  garmentImageLabel,
  isOnePiece,
  resolveItemCategory,
  resolveItemSubcategory,
  type OutfitTryOnGarment,
} from '../../src/functions/processing/outfit-context';
import { DynamoItem } from '../../src/shared/types';

function clothingItem(overrides: Partial<DynamoItem> = {}): DynamoItem {
  return {
    PK: 'WARDROBE#wd_1',
    SK: 'ITEM#item_1',
    entityType: 'ITEM',
    userId: 'uid',
    wardrobeId: 'wd_1',
    itemId: 'item_1',
    name: 'Tee',
    category: 'TOP',
    subcategory: 'TSHIRT',
    createdAt: '2026-09-06T08:00:00.000Z',
    updatedAt: '2026-09-06T08:00:00.000Z',
    ...overrides,
  };
}

function garment(
  overrides: Partial<OutfitTryOnGarment> & Pick<OutfitTryOnGarment, 'slot'>,
): OutfitTryOnGarment {
  return {
    objectKey: `users/uid/items/${overrides.slot.toLowerCase()}.png`,
    ...overrides,
  };
}

describe('resolveItemCategory / subcategory (WARDROBE-75)', () => {
  it('prefers user-set category and subcategory over AI detections', () => {
    const item = clothingItem({
      category: 'DRESS',
      subcategory: 'DRESS',
      ai: { detectedCategory: 'TOP', detectedSubcategory: 'TSHIRT' },
    });

    expect(resolveItemCategory(item, 'BOTTOM')).toBe('DRESS');
    expect(resolveItemSubcategory(item)).toBe('DRESS');
  });

  it('falls back to AI detected fields, then the outfit slot', () => {
    const item = clothingItem({
      category: undefined,
      subcategory: undefined,
      ai: { detectedCategory: 'BOTTOM', detectedSubcategory: 'JEANS' },
    });

    expect(resolveItemCategory(item, 'SHOES')).toBe('BOTTOM');
    expect(resolveItemSubcategory(item)).toBe('JEANS');
    expect(resolveItemCategory(clothingItem({ category: undefined, ai: {} }), 'OUTERWEAR')).toBe(
      'OUTERWEAR',
    );
  });

  it('copies resolved fields onto the try-on garment', () => {
    expect(
      garmentFromClothingItem(
        clothingItem({ name: 'Blue jeans', category: 'BOTTOM', subcategory: 'JEANS' }),
        'BOTTOM',
        'users/uid/items/jeans.png',
      ),
    ).toEqual({
      slot: 'BOTTOM',
      objectKey: 'users/uid/items/jeans.png',
      category: 'BOTTOM',
      subcategory: 'JEANS',
      name: 'Blue jeans',
    });
  });
});

describe('composeOutfitTryOn (WARDROBE-75)', () => {
  it('wears a TOP + BOTTOM + SHOES outfit as listed', () => {
    const garments = [
      garment({ slot: 'TOP', category: 'TOP', subcategory: 'TSHIRT', name: 'Tee' }),
      garment({ slot: 'BOTTOM', category: 'BOTTOM', subcategory: 'JEANS', name: 'Jeans' }),
      garment({ slot: 'SHOES', category: 'SHOES', subcategory: 'SNEAKERS' }),
    ];

    const composed = composeOutfitTryOn(garments);
    expect(composed.worn).toEqual(garments);
    expect(composed.omitted).toEqual([]);
  });

  it('omits jeans / BOTTOM when the outfit already has a dress', () => {
    const dress = garment({
      slot: 'DRESS',
      category: 'DRESS',
      subcategory: 'DRESS',
      name: 'Midi dress',
    });
    const jeans = garment({
      slot: 'BOTTOM',
      category: 'BOTTOM',
      subcategory: 'JEANS',
      name: 'Blue jeans',
    });
    const heels = garment({
      slot: 'SHOES',
      category: 'SHOES',
      subcategory: 'HEELS',
    });

    const composed = composeOutfitTryOn([dress, jeans, heels]);

    expect(composed.garments).toEqual([dress, jeans, heels]);
    expect(composed.worn).toEqual([dress, heels]);
    expect(composed.omitted).toEqual([
      {
        garment: jeans,
        reason:
          'BOTTOM cannot be layered on a DRESS one-piece (do not put jeans on a dress)',
      },
    ]);
  });

  it('omits a separate TOP when composing a jumpsuit one-piece', () => {
    const jumpsuit = garment({
      slot: 'DRESS',
      category: 'DRESS',
      subcategory: 'JUMPSUIT',
    });
    const blouse = garment({
      slot: 'TOP',
      category: 'TOP',
      subcategory: 'BLOUSE',
    });

    const composed = composeOutfitTryOn([jumpsuit, blouse]);
    expect(composed.worn).toEqual([jumpsuit]);
    expect(composed.omitted[0]?.reason).toBe(
      'TOP cannot be layered on a DRESS one-piece',
    );
  });

  it('treats slot=DRESS as a one-piece even without category metadata', () => {
    expect(isOnePiece(garment({ slot: 'DRESS' }))).toBe(true);
    const composed = composeOutfitTryOn([
      garment({ slot: 'DRESS' }),
      garment({ slot: 'BOTTOM', subcategory: 'JEANS' }),
    ]);
    expect(composed.worn.map((entry) => entry.slot)).toEqual(['DRESS']);
    expect(composed.omitted[0]?.garment.subcategory).toBe('JEANS');
  });
});

describe('buildTryOnPrompt (WARDROBE-75)', () => {
  it('lists every outfit item with category/subcategory and forbids jeans on a dress', () => {
    const composed = composeOutfitTryOn([
      garment({
        slot: 'DRESS',
        category: 'DRESS',
        subcategory: 'DRESS',
        name: 'Midi dress',
      }),
      garment({
        slot: 'BOTTOM',
        category: 'BOTTOM',
        subcategory: 'JEANS',
        name: 'Blue jeans',
      }),
      garment({
        slot: 'SHOES',
        category: 'SHOES',
        subcategory: 'HEELS',
      }),
    ]);

    const prompt = buildTryOnPrompt(composed);

    expect(prompt).toContain(
      'Outfit items (ground the render in this list; do not invent pieces):',
    );
    expect(prompt).toContain(
      formatGarment({
        slot: 'DRESS',
        objectKey: 'x',
        category: 'DRESS',
        subcategory: 'DRESS',
        name: 'Midi dress',
      }),
    );
    expect(prompt).toContain('slot=BOTTOM; category=BOTTOM; subcategory=JEANS; name=Blue jeans');
    expect(prompt).toContain('Wear these pieces together:');
    expect(prompt).toContain('slot=DRESS; category=DRESS; subcategory=DRESS; name=Midi dress');
    expect(prompt).toContain('slot=SHOES; category=SHOES; subcategory=HEELS');
    expect(prompt).toContain('Do not wear these incompatible pieces:');
    expect(prompt).toContain('do not put jeans on a dress');
    expect(prompt).toContain('Do not put jeans on a dress.');
    const wornSection =
      prompt
        .split('Wear these pieces together:')[1]
        ?.split('Do not wear these incompatible pieces:')[0] ?? '';
    expect(wornSection).toContain('slot=DRESS; category=DRESS; subcategory=DRESS; name=Midi dress');
    expect(wornSection).not.toContain('JEANS');
    expect(garmentImageLabel(composed.worn[0])).toBe(
      'Garment slot=DRESS; category=DRESS; subcategory=DRESS; name=Midi dress',
    );
  });

  it('does not mention omitted pieces when the outfit is already compatible', () => {
    const prompt = buildTryOnPrompt(
      composeOutfitTryOn([
        garment({ slot: 'TOP', category: 'TOP', subcategory: 'SHIRT' }),
        garment({ slot: 'BOTTOM', category: 'BOTTOM', subcategory: 'TROUSERS' }),
      ]),
    );

    expect(prompt).toContain('slot=TOP; category=TOP; subcategory=SHIRT');
    expect(prompt).toContain('slot=BOTTOM; category=BOTTOM; subcategory=TROUSERS');
    expect(prompt).not.toContain('Do not wear these incompatible pieces:');
  });
});
