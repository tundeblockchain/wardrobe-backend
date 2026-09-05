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
  classificationPrompt,
  createGeminiGarmentClassifier,
  loadClassifierConfig,
  parseClassifierSecret,
  resetClassifierSecretCache,
  resolveClassificationImageKey,
  toControlledClassification,
} from '../../src/functions/processing/classify';
import {
  DEFAULT_GEMINI_CLASSIFIER_MODEL,
  geminiGenerateContentUrl,
} from '../../src/functions/processing/gemini';
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
    const ctx = context();

    await classifyGarment(ctx, { classifier: { classify } });

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
    expect(ctx.item.ai).toEqual({
      detectedCategory: 'TOP',
      detectedSubcategory: 'TSHIRT',
    });
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

describe('Gemini garment classifier (WARDROBE-27)', () => {
  const DEFAULT_ENDPOINT = geminiGenerateContentUrl(DEFAULT_GEMINI_CLASSIFIER_MODEL);
  const IMAGE = new Uint8Array([0xff, 0xd8, 0xff, 0x01]);

  function geminiTextResponse(text: string): string {
    return JSON.stringify({
      candidates: [
        {
          content: { parts: [{ text }] },
          finishReason: 'STOP',
        },
      ],
    });
  }

  const originalArn = process.env.AI_CLASSIFIER_SECRET_ARN;
  const originalModel = process.env.GEMINI_CLASSIFIER_MODEL;
  const originalEndpoint = process.env.GEMINI_CLASSIFIER_ENDPOINT;
  const originalTable = process.env.TABLE_NAME;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
    mockUpdateAttributes.mockResolvedValue({});
    resetClassifierSecretCache();
  });

  afterEach(() => {
    resetClassifierSecretCache();
    if (originalTable === undefined) {
      delete process.env.TABLE_NAME;
    } else {
      process.env.TABLE_NAME = originalTable;
    }
    if (originalArn === undefined) {
      delete process.env.AI_CLASSIFIER_SECRET_ARN;
    } else {
      process.env.AI_CLASSIFIER_SECRET_ARN = originalArn;
    }
    if (originalModel === undefined) {
      delete process.env.GEMINI_CLASSIFIER_MODEL;
    } else {
      process.env.GEMINI_CLASSIFIER_MODEL = originalModel;
    }
    if (originalEndpoint === undefined) {
      delete process.env.GEMINI_CLASSIFIER_ENDPOINT;
    } else {
      process.env.GEMINI_CLASSIFIER_ENDPOINT = originalEndpoint;
    }
  });

  it('POSTs generateContent with image + text and maps a valid JSON classification', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        geminiTextResponse(
          JSON.stringify({ category: 'SHOES', subcategory: 'sneakers' }),
        ),
    });

    const classifier = createGeminiGarmentClassifier({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        model: DEFAULT_GEMINI_CLASSIFIER_MODEL,
        endpoint: DEFAULT_ENDPOINT,
      }),
      getImage: async () => ({
        bytes: IMAGE,
        contentType: 'image/jpeg',
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      classifier.classify({ imageKey: ORIGINAL_KEY, context: context() }),
    ).resolves.toEqual({
      detectedCategory: 'SHOES',
      detectedSubcategory: 'SNEAKERS',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      DEFAULT_ENDPOINT,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': 'test-key',
        },
      }),
    );
    const sent = JSON.parse(
      (fetchImpl.mock.calls[0][1] as { body: string }).body,
    ) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
      generationConfig: { responseMimeType: string };
    };
    expect(sent.generationConfig.responseMimeType).toBe('application/json');
    expect(sent.contents[0].parts[0]).toEqual({
      text: classificationPrompt(),
    });
    expect(sent.contents[0].parts[1]).toEqual({
      inlineData: {
        mimeType: 'image/jpeg',
        data: Buffer.from(IMAGE).toString('base64'),
      },
    });
  });

  it('accepts markdown-fenced JSON from Gemini text parts', async () => {
    const classifier = createGeminiGarmentClassifier({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        model: DEFAULT_GEMINI_CLASSIFIER_MODEL,
        endpoint: DEFAULT_ENDPOINT,
      }),
      getImage: async () => ({
        bytes: IMAGE,
        contentType: 'image/png',
      }),
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          text: async () =>
            geminiTextResponse(
              '```json\n{"detectedCategory":"TOP","detectedSubcategory":"TSHIRT"}\n```',
            ),
        }) as Response,
    });

    await expect(
      classifier.classify({ imageKey: ORIGINAL_KEY, context: context() }),
    ).resolves.toEqual({
      detectedCategory: 'TOP',
      detectedSubcategory: 'TSHIRT',
    });
  });

  it('treats HTTP 429 / 401 / 5xx as retryable so SQS can DLQ', async () => {
    const retry = createGeminiGarmentClassifier({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        model: DEFAULT_GEMINI_CLASSIFIER_MODEL,
        endpoint: DEFAULT_ENDPOINT,
      }),
      getImage: async () => ({ bytes: IMAGE, contentType: 'image/png' }),
      fetchImpl: async () => ({ ok: false, status: 503 }) as Response,
    });

    await expect(
      retry.classify({ imageKey: ORIGINAL_KEY, context: context() }),
    ).rejects.toBeInstanceOf(RetryableProcessingError);

    const unauthorized = createGeminiGarmentClassifier({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        model: DEFAULT_GEMINI_CLASSIFIER_MODEL,
        endpoint: DEFAULT_ENDPOINT,
      }),
      getImage: async () => ({ bytes: IMAGE, contentType: 'image/png' }),
      fetchImpl: async () => ({ ok: false, status: 401 }) as Response,
    });

    await expect(
      unauthorized.classify({ imageKey: ORIGINAL_KEY, context: context() }),
    ).rejects.toBeInstanceOf(RetryableProcessingError);
  });

  it('treats HTTP 400, safety blocks, and uncontrolled JSON as permanent', async () => {
    const badRequest = createGeminiGarmentClassifier({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        model: DEFAULT_GEMINI_CLASSIFIER_MODEL,
        endpoint: DEFAULT_ENDPOINT,
      }),
      getImage: async () => ({ bytes: IMAGE, contentType: 'image/png' }),
      fetchImpl: async () => ({ ok: false, status: 400 }) as Response,
    });

    await expect(
      badRequest.classify({ imageKey: ORIGINAL_KEY, context: context() }),
    ).rejects.toBeInstanceOf(PermanentProcessingError);

    const blocked = createGeminiGarmentClassifier({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        model: DEFAULT_GEMINI_CLASSIFIER_MODEL,
        endpoint: DEFAULT_ENDPOINT,
      }),
      getImage: async () => ({ bytes: IMAGE, contentType: 'image/png' }),
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              promptFeedback: { blockReason: 'SAFETY' },
              candidates: [],
            }),
        }) as Response,
    });

    await expect(
      blocked.classify({ imageKey: ORIGINAL_KEY, context: context() }),
    ).rejects.toBeInstanceOf(PermanentProcessingError);

    const uncontrolled = createGeminiGarmentClassifier({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        model: DEFAULT_GEMINI_CLASSIFIER_MODEL,
        endpoint: DEFAULT_ENDPOINT,
      }),
      getImage: async () => ({ bytes: IMAGE, contentType: 'image/png' }),
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          text: async () => geminiTextResponse(JSON.stringify({ category: 'WIDGET' })),
        }) as Response,
    });

    await expect(
      uncontrolled.classify({ imageKey: ORIGINAL_KEY, context: context() }),
    ).rejects.toBeInstanceOf(PermanentProcessingError);
  });

  it('maps network failures to retryable', async () => {
    const classifier = createGeminiGarmentClassifier({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        model: DEFAULT_GEMINI_CLASSIFIER_MODEL,
        endpoint: DEFAULT_ENDPOINT,
      }),
      getImage: async () => ({ bytes: IMAGE, contentType: 'image/png' }),
      fetchImpl: async () => {
        throw new Error('fetch failed');
      },
    });

    await expect(
      classifier.classify({ imageKey: ORIGINAL_KEY, context: context() }),
    ).rejects.toBeInstanceOf(RetryableProcessingError);
  });

  it('does not call live Gemini when a classifier is injected', async () => {
    const fetchImpl = jest.fn();
    const loadConfig = jest.fn();

    await classifyGarment(context(), {
      classifier: {
        classify: async () => ({
          detectedCategory: 'TOP',
          detectedSubcategory: 'TSHIRT',
        }),
      },
      loadConfig,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(loadConfig).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the mocked Gemini adapter when no classifier is injected', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        geminiTextResponse(
          JSON.stringify({
            detectedCategory: 'BAG',
            detectedSubcategory: 'TOTE',
          }),
        ),
    });

    await classifyGarment(context(), {
      loadConfig: async () => ({
        apiKey: 'test-key',
        model: DEFAULT_GEMINI_CLASSIFIER_MODEL,
        endpoint: DEFAULT_ENDPOINT,
      }),
      getImage: async () => ({ bytes: IMAGE, contentType: 'image/jpeg' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(mockUpdateAttributes).toHaveBeenCalledWith(
      'WARDROBE#wd_1',
      'ITEM#item_1',
      expect.objectContaining({
        ai: {
          detectedCategory: 'BAG',
          detectedSubcategory: 'TOTE',
        },
      }),
    );
  });

  it('parses a plain Gemini API key and JSON secrets with default generateContent URL', () => {
    expect(parseClassifierSecret('  gemini-key  ')).toEqual({
      apiKey: 'gemini-key',
      model: DEFAULT_GEMINI_CLASSIFIER_MODEL,
      endpoint: DEFAULT_ENDPOINT,
    });

    expect(
      parseClassifierSecret(
        JSON.stringify({
          apiKey: 'json-key',
          model: 'gemini-2.0-flash',
          endpoint:
            'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent',
        }),
      ),
    ).toEqual({
      apiKey: 'json-key',
      model: 'gemini-2.0-flash',
      endpoint:
        'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent',
    });
  });

  it('treats a missing apiKey / empty secret as retryable (placeholder not populated)', () => {
    expect(() => parseClassifierSecret('')).toThrow(RetryableProcessingError);
    expect(() =>
      parseClassifierSecret(JSON.stringify({ model: 'gemini-2.5-flash' })),
    ).toThrow(RetryableProcessingError);
  });

  it('prefers GEMINI_CLASSIFIER_MODEL and GEMINI_CLASSIFIER_ENDPOINT over the secret', async () => {
    process.env.AI_CLASSIFIER_SECRET_ARN = 'arn:secret';
    process.env.GEMINI_CLASSIFIER_MODEL = 'gemini-from-env';
    process.env.GEMINI_CLASSIFIER_ENDPOINT = 'https://env.example/generateContent';

    const config = await loadClassifierConfig(async () =>
      JSON.stringify({
        apiKey: 'from-secret',
        model: 'gemini-from-secret',
        endpoint: 'https://secret.example/generateContent',
      }),
    );

    expect(config).toEqual({
      apiKey: 'from-secret',
      model: 'gemini-from-env',
      endpoint: 'https://env.example/generateContent',
    });
  });

  it('fails retryably when the secret ARN is missing', async () => {
    delete process.env.AI_CLASSIFIER_SECRET_ARN;
    await expect(loadClassifierConfig(async () => 'key')).rejects.toBeInstanceOf(
      RetryableProcessingError,
    );
  });
});
