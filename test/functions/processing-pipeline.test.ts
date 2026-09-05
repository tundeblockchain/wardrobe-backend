import { DynamoItem } from '../../src/shared/types';

const mockRunBackgroundRemoval = jest.fn();

jest.mock('../../src/functions/processing/background-removal', () => ({
  runBackgroundRemoval: (...args: unknown[]) => mockRunBackgroundRemoval(...args),
}));

import {
  classifyGarment,
  detectColourAndCategory,
  removeBackground,
  runProcessingPipeline,
} from '../../src/functions/processing/pipeline';

const item: DynamoItem = {
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

const context = {
  userId: 'uid',
  wardrobeId: 'wd_1',
  itemId: 'item_1',
  originalImageKey: 'users/uid/uploads/photo.jpg',
  item,
};

describe('processing pipeline hooks (WARDROBE-18)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunBackgroundRemoval.mockResolvedValue(
      'users/uid/items/item_1/processed.png',
    );
  });

  it('delegates removeBackground to the injectable rembg hook', async () => {
    await expect(removeBackground(context)).resolves.toBeUndefined();
    expect(mockRunBackgroundRemoval).toHaveBeenCalledWith(context);
  });

  it('leaves classifyGarment and detectColourAndCategory as no-op stubs', async () => {
    await expect(classifyGarment(context)).resolves.toBeUndefined();
    await expect(detectColourAndCategory(context)).resolves.toBeUndefined();
    expect(mockRunBackgroundRemoval).not.toHaveBeenCalled();
  });

  it('runs rembg before the later no-op hooks', async () => {
    const order: string[] = [];
    mockRunBackgroundRemoval.mockImplementation(async () => {
      order.push('removeBackground');
    });

    await runProcessingPipeline(context);

    expect(order).toEqual(['removeBackground']);
    expect(mockRunBackgroundRemoval).toHaveBeenCalledTimes(1);
  });
});
