import { PermanentProcessingError, RetryableProcessingError } from '../../src/functions/processing/errors';
import {
  createGeminiBackgroundRemovalClient,
  DEFAULT_GEMINI_MODEL,
  geminiGenerateContentUrl,
  loadBackgroundRemovalConfig,
  parseBackgroundRemovalSecret,
  runBackgroundRemoval,
} from '../../src/functions/processing/background-removal';
import { DynamoItem } from '../../src/shared/types';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const ORIGINAL = Uint8Array.from([0xff, 0xd8, 0xff, 0x01]);
const PNG_BASE64 = Buffer.from(PNG).toString('base64');
const DEFAULT_ENDPOINT = geminiGenerateContentUrl(DEFAULT_GEMINI_MODEL);

const USER_ID = 'firebase-uid-owner';
const WARDROBE_ID = 'wd_abc123xyz0';
const ITEM_ID = 'item_xyz123abcd';
const ORIGINAL_KEY = `users/${USER_ID}/uploads/photo.jpg`;
const PROCESSED_KEY = `users/${USER_ID}/items/${ITEM_ID}/processed.png`;

function dynamoItem(overrides: Partial<DynamoItem> = {}): DynamoItem {
  return {
    PK: `WARDROBE#${WARDROBE_ID}`,
    SK: `ITEM#${ITEM_ID}`,
    entityType: 'ITEM',
    userId: USER_ID,
    wardrobeId: WARDROBE_ID,
    itemId: ITEM_ID,
    name: 'Black T-Shirt',
    originalKey: ORIGINAL_KEY,
    processingStatus: 'PROCESSING',
    createdAt: '2026-09-03T18:45:00.000Z',
    updatedAt: '2026-09-03T18:45:00.000Z',
    ...overrides,
  };
}

function context(item = dynamoItem()) {
  return {
    userId: USER_ID,
    wardrobeId: WARDROBE_ID,
    itemId: ITEM_ID,
    originalImageKey: ORIGINAL_KEY,
    item,
  };
}

function geminiImageResponse(data = PNG_BASE64): string {
  return JSON.stringify({
    candidates: [
      {
        content: {
          parts: [{ inlineData: { mimeType: 'image/png', data } }],
        },
        finishReason: 'STOP',
      },
    ],
  });
}

describe('parseBackgroundRemovalSecret', () => {
  it('accepts a plain Gemini API key and fills default model + endpoint', () => {
    expect(parseBackgroundRemovalSecret('  gemini-key  ')).toEqual({
      apiKey: 'gemini-key',
      model: DEFAULT_GEMINI_MODEL,
      endpoint: DEFAULT_ENDPOINT,
    });
  });

  it('accepts JSON with apiKey, model, and endpoint', () => {
    expect(
      parseBackgroundRemovalSecret(
        JSON.stringify({
          apiKey: 'json-key',
          model: 'gemini-3.1-flash-image',
          endpoint:
            'https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash-image:generateContent',
        }),
      ),
    ).toEqual({
      apiKey: 'json-key',
      model: 'gemini-3.1-flash-image',
      endpoint:
        'https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash-image:generateContent',
    });
  });

  it('builds a generateContent URL when JSON has a model but no endpoint', () => {
    expect(
      parseBackgroundRemovalSecret(
        JSON.stringify({
          apiKey: 'json-key',
          model: 'gemini-2.5-flash-image',
        }),
      ),
    ).toEqual({
      apiKey: 'json-key',
      model: 'gemini-2.5-flash-image',
      endpoint: geminiGenerateContentUrl('gemini-2.5-flash-image'),
    });
  });

  it('treats JSON without apiKey as retryable (secret not populated yet)', () => {
    expect(() =>
      parseBackgroundRemovalSecret(JSON.stringify({ model: 'gemini-2.5-flash-image' })),
    ).toThrow(RetryableProcessingError);
  });
});

describe('loadBackgroundRemovalConfig', () => {
  const originalArn = process.env.BACKGROUND_REMOVAL_SECRET_ARN;
  const originalModel = process.env.GEMINI_MODEL;
  const originalEndpoint = process.env.GEMINI_ENDPOINT;

  afterEach(() => {
    if (originalArn === undefined) {
      delete process.env.BACKGROUND_REMOVAL_SECRET_ARN;
    } else {
      process.env.BACKGROUND_REMOVAL_SECRET_ARN = originalArn;
    }
    if (originalModel === undefined) {
      delete process.env.GEMINI_MODEL;
    } else {
      process.env.GEMINI_MODEL = originalModel;
    }
    if (originalEndpoint === undefined) {
      delete process.env.GEMINI_ENDPOINT;
    } else {
      process.env.GEMINI_ENDPOINT = originalEndpoint;
    }
  });

  it('prefers GEMINI_MODEL and GEMINI_ENDPOINT over the secret', async () => {
    process.env.BACKGROUND_REMOVAL_SECRET_ARN = 'arn:secret';
    process.env.GEMINI_MODEL = 'gemini-from-env';
    process.env.GEMINI_ENDPOINT = 'https://env.example/generateContent';

    const config = await loadBackgroundRemovalConfig(async () =>
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

  it('defaults model and generateContent endpoint from a plain API key', async () => {
    process.env.BACKGROUND_REMOVAL_SECRET_ARN = 'arn:secret';
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_ENDPOINT;

    await expect(loadBackgroundRemovalConfig(async () => 'plain-key')).resolves.toEqual({
      apiKey: 'plain-key',
      model: DEFAULT_GEMINI_MODEL,
      endpoint: DEFAULT_ENDPOINT,
    });
  });

  it('fails retryably when the secret ARN is missing', async () => {
    delete process.env.BACKGROUND_REMOVAL_SECRET_ARN;
    await expect(loadBackgroundRemovalConfig(async () => 'key')).rejects.toBeInstanceOf(
      RetryableProcessingError,
    );
  });
});

describe('runBackgroundRemoval', () => {
  it('reads the original, writes processed.png, and updates ai + processedKey', async () => {
    const getObject = jest.fn().mockResolvedValue({
      bytes: ORIGINAL,
      contentType: 'image/jpeg',
    });
    const putObject = jest.fn().mockResolvedValue(undefined);
    const update = jest.fn().mockResolvedValue(undefined);
    const removeBackground = jest.fn().mockResolvedValue(PNG);

    const item = dynamoItem({
      ai: { detectedCategory: 'TOP' },
    });

    await expect(
      runBackgroundRemoval(context(item), {
        store: { getObject, putObject },
        metadata: { update },
        client: { removeBackground },
      }),
    ).resolves.toBe(PROCESSED_KEY);

    expect(getObject).toHaveBeenCalledWith(ORIGINAL_KEY);
    expect(removeBackground).toHaveBeenCalledWith(ORIGINAL, 'image/jpeg');
    expect(putObject).toHaveBeenCalledWith(PROCESSED_KEY, PNG, 'image/png');
    expect(update).toHaveBeenCalledWith(
      WARDROBE_ID,
      ITEM_ID,
      expect.objectContaining({
        processedKey: PROCESSED_KEY,
        ai: {
          detectedCategory: 'TOP',
          backgroundRemoved: true,
          processedImageKey: PROCESSED_KEY,
        },
      }),
    );
    expect(getObject).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite the original object key', async () => {
    const putObject = jest.fn().mockResolvedValue(undefined);

    await runBackgroundRemoval(context(), {
      store: {
        getObject: async () => ({ bytes: ORIGINAL, contentType: 'image/jpeg' }),
        putObject,
      },
      metadata: { update: async () => undefined },
      client: { removeBackground: async () => PNG },
    });

    const writtenKeys = putObject.mock.calls.map((call) => call[0]);
    expect(writtenKeys).toEqual([PROCESSED_KEY]);
    expect(writtenKeys).not.toContain(ORIGINAL_KEY);
  });

  it('treats a missing original as a permanent failure', async () => {
    const missing = new Error('The specified key does not exist.');
    missing.name = 'NoSuchKey';

    await expect(
      runBackgroundRemoval(context(), {
        store: {
          getObject: async () => {
            throw missing;
          },
          putObject: async () => undefined,
        },
        metadata: { update: async () => undefined },
        client: { removeBackground: async () => PNG },
      }),
    ).rejects.toBeInstanceOf(PermanentProcessingError);
  });

  it('treats provider 422 as permanent so the item can be marked FAILED', async () => {
    await expect(
      runBackgroundRemoval(context(), {
        store: {
          getObject: async () => ({ bytes: ORIGINAL, contentType: 'image/jpeg' }),
          putObject: async () => undefined,
        },
        metadata: { update: async () => undefined },
        client: {
          removeBackground: async () => {
            throw new PermanentProcessingError('Gemini rejected the image (422)');
          },
        },
      }),
    ).rejects.toBeInstanceOf(PermanentProcessingError);
  });

  it('treats S3 write failures as retryable so SQS can redeliver toward the DLQ', async () => {
    await expect(
      runBackgroundRemoval(context(), {
        store: {
          getObject: async () => ({ bytes: ORIGINAL, contentType: 'image/jpeg' }),
          putObject: async () => {
            throw new Error('SlowDown');
          },
        },
        metadata: { update: async () => undefined },
        client: { removeBackground: async () => PNG },
      }),
    ).rejects.toBeInstanceOf(RetryableProcessingError);
  });

  it('rejects a non-PNG provider payload as permanent', async () => {
    await expect(
      runBackgroundRemoval(context(), {
        store: {
          getObject: async () => ({ bytes: ORIGINAL, contentType: 'image/jpeg' }),
          putObject: async () => undefined,
        },
        metadata: { update: async () => undefined },
        client: { removeBackground: async () => Uint8Array.from([0x00, 0x01]) },
      }),
    ).rejects.toBeInstanceOf(PermanentProcessingError);
  });

  it('does not call live Gemini when a client is injected', async () => {
    const loadConfig = jest.fn();
    const fetchImpl = jest.fn();

    await runBackgroundRemoval(context(), {
      store: {
        getObject: async () => ({ bytes: ORIGINAL, contentType: 'image/png' }),
        putObject: async () => undefined,
      },
      metadata: { update: async () => undefined },
      client: { removeBackground: async () => PNG },
      loadConfig,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(loadConfig).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the mocked Gemini generateContent adapter when no client is injected', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => geminiImageResponse(),
    });

    await expect(
      runBackgroundRemoval(context(), {
        store: {
          getObject: async () => ({ bytes: ORIGINAL, contentType: 'image/jpeg' }),
          putObject: async () => undefined,
        },
        metadata: { update: async () => undefined },
        loadConfig: async () => ({
          apiKey: 'test-key',
          model: DEFAULT_GEMINI_MODEL,
          endpoint: DEFAULT_ENDPOINT,
        }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBe(PROCESSED_KEY);

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
    const init = fetchImpl.mock.calls[0][1] as { body: string };
    const sent = JSON.parse(init.body) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
      generationConfig: { responseModalities: string[] };
    };
    expect(sent.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE']);
    expect(sent.contents[0].parts[0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining('Remove the background') }),
    );
    expect(sent.contents[0].parts[1]).toEqual({
      inlineData: {
        mimeType: 'image/jpeg',
        data: Buffer.from(ORIGINAL).toString('base64'),
      },
    });
  });
});

describe('createGeminiBackgroundRemovalClient', () => {
  const config = {
    apiKey: 'test-key',
    model: DEFAULT_GEMINI_MODEL,
    endpoint: DEFAULT_ENDPOINT,
  };

  it('POSTs generateContent and returns PNG bytes from inlineData', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => geminiImageResponse(),
    });

    const client = createGeminiBackgroundRemovalClient(config, fetchImpl);
    await expect(client.removeBackground(ORIGINAL, 'image/jpeg')).resolves.toEqual(PNG);

    expect(fetchImpl).toHaveBeenCalledWith(
      config.endpoint,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': 'test-key',
        },
      }),
    );
  });

  it('accepts snake_case inline_data in the Gemini JSON body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ inline_data: { mime_type: 'image/png', data: PNG_BASE64 } }],
              },
            },
          ],
        }),
    });

    const client = createGeminiBackgroundRemovalClient(config, fetchImpl);
    await expect(client.removeBackground(ORIGINAL, 'image/jpeg')).resolves.toEqual(PNG);
  });

  it('maps 429 / 5xx to retryable and 4xx image errors to permanent', async () => {
    const retry = createGeminiBackgroundRemovalClient(config, async () =>
      ({ ok: false, status: 503 }) as Response,
    );
    await expect(retry.removeBackground(ORIGINAL, 'image/jpeg')).rejects.toBeInstanceOf(
      RetryableProcessingError,
    );

    const unauthorized = createGeminiBackgroundRemovalClient(config, async () =>
      ({ ok: false, status: 401 }) as Response,
    );
    await expect(unauthorized.removeBackground(ORIGINAL, 'image/jpeg')).rejects.toBeInstanceOf(
      RetryableProcessingError,
    );

    const permanent = createGeminiBackgroundRemovalClient(config, async () =>
      ({ ok: false, status: 422 }) as Response,
    );
    await expect(permanent.removeBackground(ORIGINAL, 'image/jpeg')).rejects.toBeInstanceOf(
      PermanentProcessingError,
    );
  });

  it('maps network failures to retryable', async () => {
    const client = createGeminiBackgroundRemovalClient(config, async () => {
      throw new Error('fetch failed');
    });
    await expect(client.removeBackground(ORIGINAL, 'image/jpeg')).rejects.toBeInstanceOf(
      RetryableProcessingError,
    );
  });

  it('treats a 200 without image bytes as permanent', async () => {
    const client = createGeminiBackgroundRemovalClient(config, async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'nope' }] } }] }),
      }) as Response,
    );
    await expect(client.removeBackground(ORIGINAL, 'image/jpeg')).rejects.toBeInstanceOf(
      PermanentProcessingError,
    );
  });

  it('treats a safety-blocked Gemini response as permanent', async () => {
    const client = createGeminiBackgroundRemovalClient(config, async () =>
      ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            promptFeedback: { blockReason: 'SAFETY' },
            candidates: [],
          }),
      }) as Response,
    );
    await expect(client.removeBackground(ORIGINAL, 'image/jpeg')).rejects.toBeInstanceOf(
      PermanentProcessingError,
    );
  });
});
