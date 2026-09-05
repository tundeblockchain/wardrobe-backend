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
  createDefaultColourDetector,
  createGeminiColourDetector,
  createHttpColourDetector,
  DEFAULT_GEMINI_COLOUR_MODEL,
  detectColourAndCategory,
  loadGeminiColourDetectorConfig,
  parseColourDetectorSecret,
  parseGeminiColourDetectorSecret,
  resetColourDetectorSecretCache,
  resolveColourDetectionImageKey,
  resolveColourDetectorStrategy,
  toControlledColourDetection,
  toControlledColours,
} from '../../src/functions/processing/colour-detect';
import { geminiGenerateContentUrl } from '../../src/functions/processing/gemini';
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
    colours: ['GREEN'],
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

describe('resolveColourDetectionImageKey', () => {
  it('prefers processedKey when WARDROBE-18 has already written it', () => {
    expect(
      resolveColourDetectionImageKey(
        context({ item: item({ processedKey: PROCESSED_KEY }) }),
      ),
    ).toBe(PROCESSED_KEY);
  });

  it('prefers ai.processedImageKey when top-level processedKey is absent', () => {
    expect(
      resolveColourDetectionImageKey(
        context({
          item: item({ ai: { processedImageKey: PROCESSED_KEY } }),
        }),
      ),
    ).toBe(PROCESSED_KEY);
  });

  it('falls back to the Dynamo-validated original image key', () => {
    expect(resolveColourDetectionImageKey(context())).toBe(ORIGINAL_KEY);
  });

  it('fails permanently when no image key is available', () => {
    expect(() =>
      resolveColourDetectionImageKey(
        context({
          originalImageKey: '',
          item: item({ originalKey: undefined }),
        }),
      ),
    ).toThrow(PermanentProcessingError);
  });
});

describe('toControlledColours / toControlledColourDetection', () => {
  it('accepts controlled colour tokens, aliases, and de-duplicates', () => {
    expect(
      toControlledColours(['black', 'navy-blue', 'GRAY', 'BLACK', 'chartreuse']),
    ).toEqual(['BLACK', 'NAVY', 'GREY']);
  });

  it('reads colours from detector-shaped objects', () => {
    expect(
      toControlledColourDetection({
        detectedColours: ['white', 'red'],
        detectedCategory: 'top',
        detectedSubcategory: 't-shirt',
      }),
    ).toEqual({
      detectedColours: ['WHITE', 'RED'],
      detectedCategory: 'TOP',
      detectedSubcategory: 'TSHIRT',
    });
  });

  it('refines category-only when subcategory is missing or uncontrolled', () => {
    expect(
      toControlledColourDetection({
        colours: ['BLUE'],
        category: 'SHOES',
      }),
    ).toEqual({
      detectedColours: ['BLUE'],
      detectedCategory: 'SHOES',
    });
  });

  it('keeps colours when category refinement is invalid', () => {
    expect(
      toControlledColourDetection({
        colors: ['gold'],
        detectedCategory: 'HAT',
        detectedSubcategory: 'TSHIRT',
      }),
    ).toEqual({ detectedColours: ['GOLD'] });
  });

  it('rejects empty or uncontrolled colour lists', () => {
    expect(toControlledColours([])).toBeUndefined();
    expect(toControlledColours(['chartreuse', 'neon'])).toBeUndefined();
    expect(toControlledColourDetection({ category: 'TOP' })).toBeUndefined();
  });
});

describe('detectColourAndCategory (WARDROBE-20)', () => {
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

  it('persists under ai only and does not overwrite user category / subcategory / colours', async () => {
    const detect = jest.fn().mockResolvedValue({
      detectedColours: ['BLACK', 'WHITE'],
    });
    const ctx = context();

    await detectColourAndCategory(ctx, { detector: { detect } });

    expect(detect).toHaveBeenCalledWith({
      imageKey: ORIGINAL_KEY,
      context: expect.objectContaining({ originalImageKey: ORIGINAL_KEY }),
    });
    expect(mockUpdateAttributes).toHaveBeenCalledWith(
      'WARDROBE#wd_1',
      'ITEM#item_1',
      expect.objectContaining({
        ai: {
          detectedColours: ['BLACK', 'WHITE'],
        },
      }),
    );

    const persisted = mockUpdateAttributes.mock.calls[0][2] as Record<
      string,
      unknown
    >;
    expect(persisted).not.toHaveProperty('category');
    expect(persisted).not.toHaveProperty('subcategory');
    expect(persisted).not.toHaveProperty('colours');
    expect(ctx.item.ai).toEqual({
      detectedColours: ['BLACK', 'WHITE'],
    });
    expect(ctx.item.colours).toEqual(['GREEN']);
    expect(ctx.item.category).toBe('BOTTOM');
  });

  it('detects from the processed image and merges existing ai fields', async () => {
    const detect = jest.fn().mockResolvedValue({
      detectedColours: ['NAVY'],
      detectedCategory: 'OUTERWEAR',
      detectedSubcategory: 'COAT',
    });

    await detectColourAndCategory(
      context({
        item: item({
          processedKey: PROCESSED_KEY,
          ai: {
            backgroundRemoved: true,
            processedImageKey: PROCESSED_KEY,
            detectedCategory: 'TOP',
            detectedSubcategory: 'TSHIRT',
          },
        }),
      }),
      { detector: { detect } },
    );

    expect(detect).toHaveBeenCalledWith(
      expect.objectContaining({ imageKey: PROCESSED_KEY }),
    );
    expect(mockUpdateAttributes).toHaveBeenCalledWith(
      'WARDROBE#wd_1',
      'ITEM#item_1',
      expect.objectContaining({
        ai: {
          backgroundRemoved: true,
          processedImageKey: PROCESSED_KEY,
          detectedCategory: 'OUTERWEAR',
          detectedSubcategory: 'COAT',
          detectedColours: ['NAVY'],
        },
      }),
    );
  });

  it('fails permanently when the detector returns no controlled colours', async () => {
    await expect(
      detectColourAndCategory(context(), {
        detector: {
          detect: async () =>
            ({
              detectedColours: [],
            }) as never,
        },
      }),
    ).rejects.toBeInstanceOf(PermanentProcessingError);
    expect(mockUpdateAttributes).not.toHaveBeenCalled();
  });

  it('propagates PermanentProcessingError from the detector', async () => {
    await expect(
      detectColourAndCategory(context(), {
        detector: {
          detect: async () => {
            throw new PermanentProcessingError('unusable image');
          },
        },
      }),
    ).rejects.toBeInstanceOf(PermanentProcessingError);
    expect(mockUpdateAttributes).not.toHaveBeenCalled();
  });

  it('propagates RetryableProcessingError from the detector', async () => {
    await expect(
      detectColourAndCategory(context(), {
        detector: {
          detect: async () => {
            throw new RetryableProcessingError('vision timeout');
          },
        },
      }),
    ).rejects.toBeInstanceOf(RetryableProcessingError);
  });

  it('wraps unexpected detector failures as retryable', async () => {
    await expect(
      detectColourAndCategory(context(), {
        detector: {
          detect: async () => {
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
      detectColourAndCategory(context(), {
        detector: {
          detect: async () => ({
            detectedColours: ['RED'],
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
      detectColourAndCategory(context(), {
        detector: {
          detect: async () => ({
            detectedColours: ['BEIGE'],
          }),
        },
      }),
    ).rejects.toBeInstanceOf(RetryableProcessingError);
  });
});

describe('HTTP colour detector', () => {
  const originalEndpoint = process.env.AI_COLOUR_DETECTOR_ENDPOINT;

  afterEach(() => {
    resetColourDetectorSecretCache();
    if (originalEndpoint === undefined) {
      delete process.env.AI_COLOUR_DETECTOR_ENDPOINT;
    } else {
      process.env.AI_COLOUR_DETECTOR_ENDPOINT = originalEndpoint;
    }
  });

  it('posts the image to the configured endpoint and maps a valid response', async () => {
    const httpPost = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          colours: ['navy blue', 'cream'],
          category: 'outerwear',
          subcategory: 'coat',
        }),
    });

    const detector = createHttpColourDetector({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        endpoint: 'https://colour.example/v1/detect',
      }),
      getImage: async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        contentType: 'image/jpeg',
      }),
      httpPost,
    });

    await expect(
      detector.detect({ imageKey: ORIGINAL_KEY, context: context() }),
    ).resolves.toEqual({
      detectedColours: ['NAVY', 'CREAM'],
      detectedCategory: 'OUTERWEAR',
      detectedSubcategory: 'COAT',
    });

    expect(httpPost).toHaveBeenCalledWith(
      'https://colour.example/v1/detect',
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
    const detector = createHttpColourDetector({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        endpoint: 'https://colour.example/v1/detect',
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
      detector.detect({ imageKey: ORIGINAL_KEY, context: context() }),
    ).rejects.toBeInstanceOf(RetryableProcessingError);
  });

  it('treats HTTP 400 and uncontrolled JSON as permanent', async () => {
    const badRequest = createHttpColourDetector({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        endpoint: 'https://colour.example/v1/detect',
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
      badRequest.detect({ imageKey: ORIGINAL_KEY, context: context() }),
    ).rejects.toBeInstanceOf(PermanentProcessingError);

    const uncontrolled = createHttpColourDetector({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        endpoint: 'https://colour.example/v1/detect',
      }),
      getImage: async () => ({
        bytes: new Uint8Array([1]),
        contentType: 'image/png',
      }),
      httpPost: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ colours: ['chartreuse'] }),
      }),
    });

    await expect(
      uncontrolled.detect({ imageKey: ORIGINAL_KEY, context: context() }),
    ).rejects.toBeInstanceOf(PermanentProcessingError);
  });

  it('parses JSON secrets and raw API keys with an endpoint env override', () => {
    expect(
      parseColourDetectorSecret(
        JSON.stringify({
          apiKey: 'k',
          endpoint: 'https://colour.example/detect',
        }),
      ),
    ).toEqual({
      apiKey: 'k',
      endpoint: 'https://colour.example/detect',
    });

    process.env.AI_COLOUR_DETECTOR_ENDPOINT = 'https://colour.example/from-env';
    expect(parseColourDetectorSecret('plain-api-key')).toEqual({
      apiKey: 'plain-api-key',
      endpoint: 'https://colour.example/from-env',
    });
  });

  it('fails permanently when credentials are missing', () => {
    expect(() => parseColourDetectorSecret('')).toThrow(PermanentProcessingError);
    expect(() => parseColourDetectorSecret('plain-api-key')).toThrow(
      PermanentProcessingError,
    );
  });
});

const DEFAULT_GEMINI_COLOUR_ENDPOINT = geminiGenerateContentUrl(
  DEFAULT_GEMINI_COLOUR_MODEL,
);

function geminiTextResponse(text: unknown): string {
  const payload = typeof text === 'string' ? text : JSON.stringify(text);
  return JSON.stringify({
    candidates: [
      {
        content: {
          parts: [{ text: payload }],
        },
        finishReason: 'STOP',
      },
    ],
  });
}

describe('Gemini colour detector (WARDROBE-29)', () => {
  const originalStrategy = process.env.COLOUR_DETECTOR_STRATEGY;
  const originalArn = process.env.AI_COLOUR_DETECTOR_SECRET_ARN;
  const originalModel = process.env.GEMINI_COLOUR_MODEL;
  const originalEndpoint = process.env.GEMINI_COLOUR_ENDPOINT;
  const originalTable = process.env.TABLE_NAME;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = 'wardrobe-app-test';
    mockUpdateAttributes.mockResolvedValue({});
  });

  afterEach(() => {
    resetColourDetectorSecretCache();
    if (originalStrategy === undefined) {
      delete process.env.COLOUR_DETECTOR_STRATEGY;
    } else {
      process.env.COLOUR_DETECTOR_STRATEGY = originalStrategy;
    }
    if (originalArn === undefined) {
      delete process.env.AI_COLOUR_DETECTOR_SECRET_ARN;
    } else {
      process.env.AI_COLOUR_DETECTOR_SECRET_ARN = originalArn;
    }
    if (originalModel === undefined) {
      delete process.env.GEMINI_COLOUR_MODEL;
    } else {
      process.env.GEMINI_COLOUR_MODEL = originalModel;
    }
    if (originalEndpoint === undefined) {
      delete process.env.GEMINI_COLOUR_ENDPOINT;
    } else {
      process.env.GEMINI_COLOUR_ENDPOINT = originalEndpoint;
    }
    if (originalTable === undefined) {
      delete process.env.TABLE_NAME;
    } else {
      process.env.TABLE_NAME = originalTable;
    }
  });

  it('defaults the colour strategy to Gemini and keeps http as a non-vendor path', () => {
    delete process.env.COLOUR_DETECTOR_STRATEGY;
    expect(resolveColourDetectorStrategy()).toBe('gemini');

    process.env.COLOUR_DETECTOR_STRATEGY = 'http';
    expect(resolveColourDetectorStrategy()).toBe('http');

    const httpPost = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ colours: ['black'] }),
    });
    const detector = createDefaultColourDetector({
      fetchHttpSecret: async () => ({
        apiKey: 'http-key',
        endpoint: 'https://colour.example/detect',
      }),
      getImage: async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        contentType: 'image/jpeg',
      }),
      httpPost,
    });

    return expect(
      detector.detect({ imageKey: ORIGINAL_KEY, context: context() }),
    ).resolves.toEqual({ detectedColours: ['BLACK'] });
  });

  it('parses a plain Gemini API key and JSON secret with optional model/endpoint', () => {
    expect(parseGeminiColourDetectorSecret('  gemini-key  ')).toEqual({
      apiKey: 'gemini-key',
      model: DEFAULT_GEMINI_COLOUR_MODEL,
      endpoint: DEFAULT_GEMINI_COLOUR_ENDPOINT,
    });

    expect(
      parseGeminiColourDetectorSecret(
        JSON.stringify({
          apiKey: 'json-key',
          model: 'gemini-2.5-pro',
          endpoint:
            'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-pro:generateContent',
        }),
      ),
    ).toEqual({
      apiKey: 'json-key',
      model: 'gemini-2.5-pro',
      endpoint:
        'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-pro:generateContent',
    });

    expect(
      parseGeminiColourDetectorSecret(
        JSON.stringify({
          apiKey: 'json-key',
          model: 'gemini-2.5-flash',
        }),
      ),
    ).toEqual({
      apiKey: 'json-key',
      model: 'gemini-2.5-flash',
      endpoint: geminiGenerateContentUrl('gemini-2.5-flash'),
    });
  });

  it('treats an empty or placeholder Gemini secret as retryable (soft failure)', () => {
    expect(() => parseGeminiColourDetectorSecret('')).toThrow(
      RetryableProcessingError,
    );
    expect(() =>
      parseGeminiColourDetectorSecret(JSON.stringify({ model: 'gemini-2.5-flash' })),
    ).toThrow(RetryableProcessingError);
  });

  it('prefers GEMINI_COLOUR_MODEL and GEMINI_COLOUR_ENDPOINT over the secret', async () => {
    process.env.AI_COLOUR_DETECTOR_SECRET_ARN = 'arn:secret';
    process.env.GEMINI_COLOUR_MODEL = 'gemini-from-env';
    process.env.GEMINI_COLOUR_ENDPOINT = 'https://env.example/generateContent';

    await expect(
      loadGeminiColourDetectorConfig(async () =>
        JSON.stringify({
          apiKey: 'from-secret',
          model: 'gemini-from-secret',
          endpoint: 'https://secret.example/generateContent',
        }),
      ),
    ).resolves.toEqual({
      apiKey: 'from-secret',
      model: 'gemini-from-env',
      endpoint: 'https://env.example/generateContent',
    });
  });

  it('fails retryably when the colour secret ARN is missing', async () => {
    delete process.env.AI_COLOUR_DETECTOR_SECRET_ARN;
    await expect(
      loadGeminiColourDetectorConfig(async () => 'key'),
    ).rejects.toBeInstanceOf(RetryableProcessingError);
  });

  it('POSTs generateContent with image+text and maps a controlled colour JSON body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        geminiTextResponse({
          detectedColours: ['navy blue', 'cream'],
          detectedCategory: 'outerwear',
          detectedSubcategory: 'coat',
        }),
    });

    const detector = createGeminiColourDetector({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        model: DEFAULT_GEMINI_COLOUR_MODEL,
        endpoint: DEFAULT_GEMINI_COLOUR_ENDPOINT,
      }),
      getImage: async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        contentType: 'image/jpeg',
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      detector.detect({ imageKey: ORIGINAL_KEY, context: context() }),
    ).resolves.toEqual({
      detectedColours: ['NAVY', 'CREAM'],
      detectedCategory: 'OUTERWEAR',
      detectedSubcategory: 'COAT',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      DEFAULT_GEMINI_COLOUR_ENDPOINT,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': 'test-key',
        },
      }),
    );
    const init = fetchImpl.mock.calls[0][1] as { body: string };
    const sent = JSON.parse(init.body) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
      generationConfig: { responseMimeType: string };
    };
    expect(sent.generationConfig.responseMimeType).toBe('application/json');
    expect(sent.contents[0].parts[0]).toEqual(
      expect.objectContaining({
        text: expect.stringContaining('detectedColours'),
      }),
    );
    expect(sent.contents[0].parts[1]).toEqual({
      inlineData: {
        mimeType: 'image/jpeg',
        data: Buffer.from([1, 2, 3]).toString('base64'),
      },
    });
  });

  it('accepts markdown-fenced JSON from Gemini', async () => {
    const detector = createGeminiColourDetector({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        model: DEFAULT_GEMINI_COLOUR_MODEL,
        endpoint: DEFAULT_GEMINI_COLOUR_ENDPOINT,
      }),
      getImage: async () => ({
        bytes: new Uint8Array([9]),
        contentType: 'image/png',
      }),
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          text: async () =>
            geminiTextResponse('```json\n{"colours":["black","white"]}\n```'),
        }) as Response,
    });

    await expect(
      detector.detect({ imageKey: ORIGINAL_KEY, context: context() }),
    ).resolves.toEqual({ detectedColours: ['BLACK', 'WHITE'] });
  });

  it('maps 429 / 5xx / 401 to retryable and other 4xx to permanent', async () => {
    const retry = createGeminiColourDetector({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        model: DEFAULT_GEMINI_COLOUR_MODEL,
        endpoint: DEFAULT_GEMINI_COLOUR_ENDPOINT,
      }),
      getImage: async () => ({
        bytes: new Uint8Array([1]),
        contentType: 'image/png',
      }),
      fetchImpl: async () => ({ ok: false, status: 503 }) as Response,
    });
    await expect(
      retry.detect({ imageKey: ORIGINAL_KEY, context: context() }),
    ).rejects.toBeInstanceOf(RetryableProcessingError);

    const unauthorized = createGeminiColourDetector({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        model: DEFAULT_GEMINI_COLOUR_MODEL,
        endpoint: DEFAULT_GEMINI_COLOUR_ENDPOINT,
      }),
      getImage: async () => ({
        bytes: new Uint8Array([1]),
        contentType: 'image/png',
      }),
      fetchImpl: async () => ({ ok: false, status: 401 }) as Response,
    });
    await expect(
      unauthorized.detect({ imageKey: ORIGINAL_KEY, context: context() }),
    ).rejects.toBeInstanceOf(RetryableProcessingError);

    const permanent = createGeminiColourDetector({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        model: DEFAULT_GEMINI_COLOUR_MODEL,
        endpoint: DEFAULT_GEMINI_COLOUR_ENDPOINT,
      }),
      getImage: async () => ({
        bytes: new Uint8Array([1]),
        contentType: 'image/png',
      }),
      fetchImpl: async () => ({ ok: false, status: 400 }) as Response,
    });
    await expect(
      permanent.detect({ imageKey: ORIGINAL_KEY, context: context() }),
    ).rejects.toBeInstanceOf(PermanentProcessingError);
  });

  it('maps network failures to retryable', async () => {
    const detector = createGeminiColourDetector({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        model: DEFAULT_GEMINI_COLOUR_MODEL,
        endpoint: DEFAULT_GEMINI_COLOUR_ENDPOINT,
      }),
      getImage: async () => ({
        bytes: new Uint8Array([1]),
        contentType: 'image/png',
      }),
      fetchImpl: async () => {
        throw new Error('fetch failed');
      },
    });

    await expect(
      detector.detect({ imageKey: ORIGINAL_KEY, context: context() }),
    ).rejects.toBeInstanceOf(RetryableProcessingError);
  });

  it('treats a safety-blocked Gemini response as permanent', async () => {
    const detector = createGeminiColourDetector({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        model: DEFAULT_GEMINI_COLOUR_MODEL,
        endpoint: DEFAULT_GEMINI_COLOUR_ENDPOINT,
      }),
      getImage: async () => ({
        bytes: new Uint8Array([1]),
        contentType: 'image/png',
      }),
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
      detector.detect({ imageKey: ORIGINAL_KEY, context: context() }),
    ).rejects.toBeInstanceOf(PermanentProcessingError);
  });

  it('treats uncontrolled Gemini colours as a permanent soft failure', async () => {
    const detector = createGeminiColourDetector({
      fetchSecret: async () => ({
        apiKey: 'test-key',
        model: DEFAULT_GEMINI_COLOUR_MODEL,
        endpoint: DEFAULT_GEMINI_COLOUR_ENDPOINT,
      }),
      getImage: async () => ({
        bytes: new Uint8Array([1]),
        contentType: 'image/png',
      }),
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          text: async () => geminiTextResponse({ colours: ['chartreuse'] }),
        }) as Response,
    });

    await expect(
      detector.detect({ imageKey: ORIGINAL_KEY, context: context() }),
    ).rejects.toBeInstanceOf(PermanentProcessingError);
  });

  it('does not call live Gemini when a detector is injected', async () => {
    const fetchImpl = jest.fn();
    const detect = jest.fn().mockResolvedValue({
      detectedColours: ['RED'],
    });

    await detectColourAndCategory(context(), { detector: { detect } });

    expect(detect).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockUpdateAttributes).toHaveBeenCalled();
  });

  it('uses the mocked Gemini adapter as the default strategy', async () => {
    delete process.env.COLOUR_DETECTOR_STRATEGY;
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => geminiTextResponse({ detectedColours: ['beige'] }),
    });

    const detector = createDefaultColourDetector({
      fetchGeminiSecret: async () => ({
        apiKey: 'test-key',
        model: DEFAULT_GEMINI_COLOUR_MODEL,
        endpoint: DEFAULT_GEMINI_COLOUR_ENDPOINT,
      }),
      getImage: async () => ({
        bytes: new Uint8Array([4, 5]),
        contentType: 'image/webp',
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      detector.detect({ imageKey: ORIGINAL_KEY, context: context() }),
    ).resolves.toEqual({ detectedColours: ['BEIGE'] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
