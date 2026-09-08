import { DynamoItem } from '../../src/shared/types';

const mockRunBackgroundRemoval = jest.fn();

jest.mock('../../src/functions/processing/background-removal', () => {
  const actual = jest.requireActual(
    '../../src/functions/processing/background-removal',
  ) as typeof import('../../src/functions/processing/background-removal');
  return {
    ...actual,
    runBackgroundRemoval: (...args: unknown[]) => mockRunBackgroundRemoval(...args),
  };
});

import { PermanentProcessingError } from '../../src/functions/processing/errors';
import { isBackgroundRemovalEnabled } from '../../src/functions/processing/background-removal';
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

describe('isBackgroundRemovalEnabled (WARDROBE-62)', () => {
  const original = process.env.BACKGROUND_REMOVAL_ENABLED;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.BACKGROUND_REMOVAL_ENABLED;
    } else {
      process.env.BACKGROUND_REMOVAL_ENABLED = original;
    }
  });

  it('is off by default so Gemini bg-removal cannot block add-item', () => {
    delete process.env.BACKGROUND_REMOVAL_ENABLED;
    expect(isBackgroundRemovalEnabled()).toBe(false);
    expect(isBackgroundRemovalEnabled('')).toBe(false);
    expect(isBackgroundRemovalEnabled('false')).toBe(false);
    expect(isBackgroundRemovalEnabled('0')).toBe(false);
    expect(isBackgroundRemovalEnabled('no')).toBe(false);
    expect(isBackgroundRemovalEnabled('off')).toBe(false);
  });

  it('turns on only for true / 1 / yes / on', () => {
    expect(isBackgroundRemovalEnabled('true')).toBe(true);
    expect(isBackgroundRemovalEnabled('TRUE')).toBe(true);
    expect(isBackgroundRemovalEnabled('1')).toBe(true);
    expect(isBackgroundRemovalEnabled('yes')).toBe(true);
    expect(isBackgroundRemovalEnabled('on')).toBe(true);
    process.env.BACKGROUND_REMOVAL_ENABLED = 'true';
    expect(isBackgroundRemovalEnabled()).toBe(true);
  });
});

describe('processing pipeline hooks (WARDROBE-18/26 + WARDROBE-19/27 + WARDROBE-20/29)', () => {
  const originalFlag = process.env.BACKGROUND_REMOVAL_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.BACKGROUND_REMOVAL_ENABLED = 'true';
    mockRunBackgroundRemoval.mockResolvedValue(PROCESSED_KEY);
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.BACKGROUND_REMOVAL_ENABLED;
    } else {
      process.env.BACKGROUND_REMOVAL_ENABLED = originalFlag;
    }
  });

  it('delegates removeBackground to the injectable Gemini hook', async () => {
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

  it('runs Gemini bg-remove, classify, then colour and prefers the processed image key', async () => {
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

  it('skips Gemini bg-removal when BACKGROUND_REMOVAL_ENABLED is off and uses the original image', async () => {
    delete process.env.BACKGROUND_REMOVAL_ENABLED;
    const ctx = context();
    const classify = jest.fn().mockImplementation(async (input: { imageKey: string }) => {
      expect(input.imageKey).toBe(ctx.originalImageKey);
      return { detectedCategory: 'TOP', detectedSubcategory: 'TSHIRT' };
    });
    const detect = jest.fn().mockImplementation(async (input: { imageKey: string }) => {
      expect(input.imageKey).toBe(ctx.originalImageKey);
      return { detectedColours: ['BLACK'] };
    });
    const persistAi = jest.fn().mockResolvedValue(undefined);

    await runProcessingPipeline(ctx, {
      classifier: { classify },
      detector: { detect },
      persistAi,
    });

    expect(mockRunBackgroundRemoval).not.toHaveBeenCalled();
    expect(ctx.item.processedKey).toBeUndefined();
    expect(ctx.item.ai).toBeUndefined();
    expect(classify).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(persistAi).toHaveBeenCalledTimes(2);
  });

  it('does not call Gemini bg-removal from removeBackground when the flag is false', async () => {
    process.env.BACKGROUND_REMOVAL_ENABLED = 'false';
    const ctx = context();

    await expect(removeBackground(ctx)).resolves.toBeUndefined();

    expect(mockRunBackgroundRemoval).not.toHaveBeenCalled();
    expect(ctx.item.processedKey).toBeUndefined();
  });

  it('logs skip / classify-fail fields when bg-removal is off and Gemini returns 404', async () => {
    delete process.env.BACKGROUND_REMOVAL_ENABLED;
    const lines: Array<Record<string, unknown>> = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(JSON.parse(String(line)) as Record<string, unknown>);
    });

    const classify = jest.fn().mockRejectedValue(
      new PermanentProcessingError('Gemini classifier rejected the request (404)'),
    );

    await expect(
      runProcessingPipeline(context(), {
        classifier: { classify },
        detector: { detect: jest.fn() },
        persistAi: jest.fn(),
      }),
    ).rejects.toMatchObject({
      name: 'PermanentProcessingError',
      message: 'Gemini classifier rejected the request (404)',
    });

    spy.mockRestore();
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'bg-removal',
          pipelineEvent: 'skip',
          reason: 'BACKGROUND_REMOVAL_ENABLED is off',
        }),
        expect.objectContaining({
          stage: 'classify',
          pipelineEvent: 'fail',
          error: 'Gemini classifier rejected the request (404)',
        }),
      ]),
    );
    expect(classify).toHaveBeenCalledTimes(1);
  });
});
