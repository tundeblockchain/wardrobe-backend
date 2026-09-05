import { DynamoItem } from '../../src/shared/types';

const mockRunBackgroundRemoval = jest.fn();

jest.mock('../../src/functions/processing/background-removal', () => ({
  runBackgroundRemoval: (...args: unknown[]) => mockRunBackgroundRemoval(...args),
}));

import {
  classifyGarment,
  detectColourAndCategory,
  ProcessingContext,
  removeBackground,
  runProcessingPipeline,
} from '../../src/functions/processing/pipeline';

const PROCESSED_KEY = 'users/uid/items/item_1/processed.png';

function item(): DynamoItem {
  return {
    PK: 'WARDROBE#wd_1',
    SK: 'ITEM#item_1',
    entityType: 'ITEM',
    userId: 'uid',
    wardrobeId: 'wd_1',
    itemId: 'item_1',
    originalKey: 'users/uid/uploads/photo.jpg',
    processingStatus: 'PROCESSING',
    createdAt: '2026-09-03T18:45:00.000Z',
    updatedAt: '2026-09-03T18:45:00.000Z',
  };
}

function context(): ProcessingContext {
  return {
    userId: 'uid',
    wardrobeId: 'wd_1',
    itemId: 'item_1',
    originalImageKey: 'users/uid/uploads/photo.jpg',
    item: item(),
  };
}

describe('processing pipeline hooks (WARDROBE-18 + WARDROBE-19 + WARDROBE-20)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunBackgroundRemoval.mockResolvedValue(PROCESSED_KEY);
  });

  it('delegates removeBackground to the injectable rembg hook', async () => {
    const ctx = context();
    await expect(removeBackground(ctx)).resolves.toBeUndefined();
    expect(mockRunBackgroundRemoval).toHaveBeenCalledWith(ctx);
    expect(ctx.item.processedKey).toBe(PROCESSED_KEY);
  });

  it('runs classifyGarment via the injectable client without a live vision API', async () => {
    const classify = jest.fn().mockResolvedValue({
      detectedCategory: 'TOP',
      detectedSubcategory: 'TSHIRT',
    });
    const persistAi = jest.fn().mockResolvedValue(undefined);
    const ctx = context();

    await expect(
      classifyGarment(ctx, { classifier: { classify }, persistAi }),
    ).resolves.toBeUndefined();

    expect(classify).toHaveBeenCalledTimes(1);
    expect(persistAi).toHaveBeenCalledTimes(1);
    expect(mockRunBackgroundRemoval).not.toHaveBeenCalled();
  });

  it('runs detectColourAndCategory via the injectable client without a live vision API', async () => {
    const detect = jest.fn().mockResolvedValue({
      detectedColours: ['BLACK'],
    });
    const persistAi = jest.fn().mockResolvedValue(undefined);
    const ctx = context();

    await expect(
      detectColourAndCategory(ctx, { detector: { detect }, persistAi }),
    ).resolves.toBeUndefined();

    expect(detect).toHaveBeenCalledTimes(1);
    expect(persistAi).toHaveBeenCalledTimes(1);
    expect(mockRunBackgroundRemoval).not.toHaveBeenCalled();
  });

  it('runs rembg, classify, then colour and prefers the processed image key', async () => {
    const order: string[] = [];
    mockRunBackgroundRemoval.mockImplementation(async () => {
      order.push('removeBackground');
      return PROCESSED_KEY;
    });
    const classify = jest.fn().mockImplementation(async (input: { imageKey: string }) => {
      order.push('classifyGarment');
      expect(input.imageKey).toBe(PROCESSED_KEY);
      return { detectedCategory: 'TOP', detectedSubcategory: 'TSHIRT' };
    });
    const detect = jest.fn().mockImplementation(async (input: { imageKey: string }) => {
      order.push('detectColourAndCategory');
      expect(input.imageKey).toBe(PROCESSED_KEY);
      return { detectedColours: ['BLACK', 'WHITE'] };
    });
    const persistAi = jest.fn().mockResolvedValue(undefined);

    await runProcessingPipeline(context(), {
      classifier: { classify },
      detector: { detect },
      persistAi,
    });

    expect(order).toEqual([
      'removeBackground',
      'classifyGarment',
      'detectColourAndCategory',
    ]);
    expect(mockRunBackgroundRemoval).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(persistAi).toHaveBeenCalledTimes(2);
  });
});
