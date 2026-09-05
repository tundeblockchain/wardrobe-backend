import { DynamoItem } from '../../src/shared/types';
import {
  PermanentProcessingError,
  RetryableProcessingError,
} from '../../src/functions/processing/errors';

const mockUpdateAttributes = jest.fn();

jest.mock('../../src/shared/dynamodb', () => ({
  keys: {
    wardrobePk: (wardrobeId: string) => `WARDROBE#${wardrobeId}`,
    itemSk: (itemId: string) => `ITEM#${itemId}`,
  },
  updateAttributes: (...args: unknown[]) => mockUpdateAttributes(...args),
}));

import {
  classifyGarment,
  createHttpGarmentClassifier,
  parseClassifierSecret,
  resetClassifierSecretCache,
  resolveClassificationImageKey,
  toControlledClassification,
} from '../../src/functions/processing/classify';
import { ProcessingContext } from '../../src/functions/processing/pipeline';

const ORIGINAL_KEY = 'users/uid/uploads/photo.jpg';
const PROCESSED_KEY = 'users/uid/items/item_1/processed.png';

function item(overrides: Partial<DynamoItem> = {}): DynamoItem {
  return {
    PK: 'WARDROBE#wd_1',
    SK: 'ITEM#item_1',
    entityType: 'ITEM',
    userId: 'uid',
    wardrobeId: 'wd_1',
    itemId: 'item_1',
    name: 'Black T-Shirt',
    category: 'BOTTOM',
    subcategory: 'JEANS',
    originalKey: ORIGINAL_KEY,
    processingStatus: 'PROCESSING',
    createdAt: '2026-09-03T18:45:00.000Z',
    updatedAt: '2026-09-03T18:45:00.000Z',
    ...overrides,
  };
}

function context(overrides: Partial<ProcessingContext> = {}): ProcessingContext {
  const dynamoItem = overrides.item ?? item();
  return {
    userId: 'uid',
    wardrobeId: 'wd_1',
    itemId: 'item_1',
    originalImageKey: ORIGINAL_KEY,
    item: dynamoItem,
    ...overrides,
  };
}

describe('resolveClassificationImageKey', () => {
  it('prefers processedKey when WARDROBE-18 has already written it', () => {
    expect(
      resolveClassificationImageKey(
        context({ item: item({ processedKey: PROCESSED_KEY }) }),
      ),
    ).toBe(PROCESSED_KEY);
  });

  it('prefers ai.processedImageKey when top-level processedKey is absent', () => {
    expect(
      resolveClassificationImageKey(
        context({
          item: item({ ai: { processedImageKey: PROCESSED_KEY } }),
        }),
      ),
    ).toBe(PROCESSED_KEY);
  });

  it('falls back to the Dynamo-validated original image key', () => {
    expect(resolveClassificationImageKey(context())).toBe(ORIGINAL_KEY);
  });

  it('fails permanently when no image key is available', () => {
    expect(() =>
      resolveClassificationImageKey(
        context({
          originalImageKey: '',
          item: item({ originalKey: undefined }),
        }),
      ),
    ).toThrow(PermanentProcessingError);
  });
});

describe('toControlledClassification', () => {
  it('accepts controlled category / subcategory pairs and aliases', () => {
    expect(
      toControlledClassification({
        detectedCategory: 'top',
        detectedSubcategory: 't-shirt',
      }),
    ).toEqual({ detectedCategory: 'TOP', detectedSubcategory: 'TSHIRT' });
  });

  it('rejects a subcategory that does not belong to the category', () => {
    expect(
      toControlledClassification({
        category: 'TOP',
        subcategory: 'JEANS',
      }),
    ).toBeUndefined();
  });

  it('rejects unknown categories', () => {
    expect(
      toControlledClassification({
        detectedCategory: 'HAT',
        detectedSubcategory: 'TSHIRT',
      }),
    ).toBeUndefined();
  });
});

describe('classifyGarment (WARDROBE-19)', () => {
  const originalTable = process.env.TABLE_NAME;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
    mockUpdateAttributes.mockResolvedValue({});
  });

  afterEach(() => {
    if (originalTable === undefined) {
      delete process.env.TABLE_NAME;
    } else {
      process.env.TABLE_NAME = originalTable;
    }
  });

  it('persists under ai only and does not overwrite user category / subcategory', async () => {
    const classify = jest.fn().mockResolvedValue({
      detectedCategory: 'TOP',
      detectedSubcategory: 'TSHIRT',
    });

    await classifyGarment(context(), { classifier: { classify } });

    expect(classify).toHaveBeenCalledWith({
      imageKey: ORIGINAL_KEY,
      context: expect.objectContaining({ originalImageKey: ORIGINAL_KEY }),
    });
    expect(mockUpdateAttributes).toHaveBeenCalledWith(
      'WARDROBE#wd_1',
      'ITEM#item_1',
      expect.objectContaining({
        ai: {
          detectedCategory: 'TOP',
          detectedSubcategory: 'TSHIRT',
        },
      }),
    );

    const persisted = mockUpdateAttributes.mock.calls[0][2] as Record<
      string,
      unknown
    >;
    expect(persisted).not.toHaveProperty('category');
    expect(persisted).not.toHaveProperty('subcategory');
  });

  it('classifies the processed image when present and merges existing ai fields', async () => {
    const classify = jest.fn().mockResolvedValue({
      detectedCategory: 'OUTERWEAR',
      detectedSubcategory: 'COAT',
    });

    await classifyGarment(
      context({
        item: item({
          processedKey: PROCESSED_KEY,
          ai: { backgroundRemoved: true, detectedColours: ['BLACK'] },
        }),
      }),
      { classifier: { classify } },
    );

    expect(classify).toHaveBeenCalledWith(
      expect.objectContaining({ imageKey: PROCESSED_KEY }),
    );
    expect(mockUpdateAttributes).toHaveBeenCalledWith(
      'WARDROBE#wd_1',
      'ITEM#item_1',
      expect.objectContaining({
        ai: {
          backgroundRemoved: true,
          detectedColours: ['BLACK'],
          detectedCategory: 'OUTERWEAR',
          detectedSubcategory: 'COAT',
        },
      }),
    );
  });

  it('fails permanently when the classifier returns an uncontrolled pair', async () => {
    await expect(
      classifyGarment(context(), {
        classifier: {
          classify: async () =>
            ({
              detectedCategory: 'TOP',
              detectedSubcategory: 'JEANS',
            }) as never,
        },
      }),
    ).rejects.toBeInstanceOf(PermanentProcessingError);
    expect(mockUpdateAttributes).not.toHaveBeenCalled();
  });

  it('propagates PermanentProcessingError from the classifier', async () => {
    await expect(
      classifyGarment(context(), {
        classifier: {
          classify: async () => {
            throw new PermanentProcessingError('unusable image');
          },
        },
      }),
    ).rejects.toBeInstanceOf(PermanentProcessingError);
    expect(mockUpdateAttributes).not.toHaveBeenCalled();
  });

  it('propagates RetryableProcessingError from the classifier', async () => {
    await expect(
      classifyGarment(context(), {
        classifier: {
          classify: async () => {
            throw new RetryableProcessingError('vision timeout');
          },
        },
      }),
    ).rejects.toBeInstanceOf(RetryableProcessingError);
  });

  it('wraps unexpected classifier failures as retryable', async () => {
    await expect(
      classifyGarment(context(), {
        classifier: {
          classify: async () => {
            throw new Error('socket hang up');
          },
        },
      }),
    ).rejects.toBeInstanceOf(RetryableProcessingError);
  });

  it('treats a disappearing item during persist as permanent', async () => {
    const missing = new Error('The conditional request failed');
    missing.name = 'ConditionalCheckFailedException';
    mockUpdateAttributes.mockRejectedValue(missing);

    await expect(
      classifyGarment(context(), {
        classifier: {
          classify: async () => ({
            detectedCategory: 'TOP',
            detectedSubcategory: 'TSHIRT',
          }),
        },
      }),
    ).rejects.toBeInstanceOf(PermanentProcessingError);
  });

  it('wraps DynamoDB throttles while persisting as retryable', async () => {
    const throttle = new Error('Throughput exceeds the current capacity');
    throttle.name = 'ThrottlingException';
    mockUpdateAttributes.mockRejectedValue(throttle);

    await expect(
      classifyGarment(context(), {
        classifier: {
          classify: async () => ({
            detectedCategory: 'BAG',
            detectedSubcategory: 'TOTE',
          }),
        },
      }),
    ).rejects.toBeInstanceOf(RetryableProcessingError);
  });
});

describe('HTTP garment classifier', () => {
  const originalEndpoint = process.env.AI_CLASSIFIER_ENDPOINT;

  afterEach(() => {
    resetClassifierSecretCache();
    if (originalEndpoint === undefined) {
      delete process.env.AI_CLASSIFIER_ENDPOINT;
    } else {
      process.env.AI_CLASSIFIER_ENDPOINT = originalEndpoint;
    }
  });

  it('posts the image to the configured endpoint and maps a valid response', async () => {
    const httpPost = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ category: 'SHOES', subcategory: 'sneakers' }),
    });

    const classifier = createHttpGarmentClassifier({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        endpoint: 'https://classifier.example/v1/classify',
      }),
      getImage: async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        contentType: 'image/jpeg',
      }),
      httpPost,
    });

    await expect(
      classifier.classify({ imageKey: ORIGINAL_KEY, context: context() }),
    ).resolves.toEqual({
      detectedCategory: 'SHOES',
      detectedSubcategory: 'SNEAKERS',
    });

    expect(httpPost).toHaveBeenCalledWith(
      'https://classifier.example/v1/classify',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
      }),
    );
    const body = JSON.parse(
      (httpPost.mock.calls[0][1] as { body: string }).body,
    ) as { imageKey: string; imageBase64: string };
    expect(body.imageKey).toBe(ORIGINAL_KEY);
    expect(body.imageBase64).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });

  it('treats HTTP 429 / 5xx as retryable', async () => {
    const classifier = createHttpGarmentClassifier({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        endpoint: 'https://classifier.example/v1/classify',
      }),
      getImage: async () => ({
        bytes: new Uint8Array([1]),
        contentType: 'image/png',
      }),
      httpPost: async () => ({
        ok: false,
        status: 503,
        text: async () => 'unavailable',
      }),
    });

    await expect(
      classifier.classify({ imageKey: ORIGINAL_KEY, context: context() }),
    ).rejects.toBeInstanceOf(RetryableProcessingError);
  });

  it('treats HTTP 400 and uncontrolled JSON as permanent', async () => {
    const badRequest = createHttpGarmentClassifier({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        endpoint: 'https://classifier.example/v1/classify',
      }),
      getImage: async () => ({
        bytes: new Uint8Array([1]),
        contentType: 'image/png',
      }),
      httpPost: async () => ({
        ok: false,
        status: 400,
        text: async () => 'bad image',
      }),
    });

    await expect(
      badRequest.classify({ imageKey: ORIGINAL_KEY, context: context() }),
    ).rejects.toBeInstanceOf(PermanentProcessingError);

    const uncontrolled = createHttpGarmentClassifier({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        endpoint: 'https://classifier.example/v1/classify',
      }),
      getImage: async () => ({
        bytes: new Uint8Array([1]),
        contentType: 'image/png',
      }),
      httpPost: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ category: 'WIDGET' }),
      }),
    });

    await expect(
      uncontrolled.classify({ imageKey: ORIGINAL_KEY, context: context() }),
    ).rejects.toBeInstanceOf(PermanentProcessingError);
  });

  it('parses JSON secrets and raw API keys with an endpoint env override', () => {
    expect(
      parseClassifierSecret(
        JSON.stringify({
          apiKey: 'k',
          endpoint: 'https://classifier.example/classify',
        }),
      ),
    ).toEqual({
      apiKey: 'k',
      endpoint: 'https://classifier.example/classify',
    });

    process.env.AI_CLASSIFIER_ENDPOINT = 'https://classifier.example/from-env';
    expect(parseClassifierSecret('plain-api-key')).toEqual({
      apiKey: 'plain-api-key',
      endpoint: 'https://classifier.example/from-env',
    });
  });

  it('fails permanently when credentials are missing', () => {
    expect(() => parseClassifierSecret('')).toThrow(PermanentProcessingError);
    expect(() => parseClassifierSecret('plain-api-key')).toThrow(
      PermanentProcessingError,
    );
  });
});
