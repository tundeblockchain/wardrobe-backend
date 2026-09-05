import {
  classifyGarment,
  detectColourAndCategory,
  removeBackground,
  runProcessingPipeline,
} from '../../src/functions/processing/pipeline';
import { DynamoItem } from '../../src/shared/types';

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

describe('processing pipeline hooks (WARDROBE-17 stubs)', () => {
  it('exposes ordered no-op hooks for WARDROBE-18 / 19 / 20', async () => {
    await expect(removeBackground(context)).resolves.toBeUndefined();
    await expect(classifyGarment(context)).resolves.toBeUndefined();
    await expect(detectColourAndCategory(context)).resolves.toBeUndefined();
    await expect(runProcessingPipeline(context)).resolves.toBeUndefined();
  });
});
