import { PermanentProcessingError, RetryableProcessingError } from '../../src/functions/processing/errors';
import {
  createHttpBackgroundRemovalClient,
  loadBackgroundRemovalConfig,
  parseBackgroundRemovalSecret,
  runBackgroundRemoval,
} from '../../src/functions/processing/background-removal';
import { DynamoItem } from '../../src/shared/types';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const ORIGINAL = Uint8Array.from([0xff, 0xd8, 0xff, 0x01]);

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

describe('parseBackgroundRemovalSecret', () => {
  it('accepts a plain API key string', () => {
    expect(parseBackgroundRemovalSecret('  provider-key  ')).toEqual({
      apiKey: 'provider-key',
      endpoint: '',
    });
  });

  it('accepts JSON with apiKey and endpoint', () => {
    expect(
      parseBackgroundRemovalSecret(
        JSON.stringify({
          apiKey: 'json-key',
          endpoint: 'https://rembg.example/api/remove',
          fieldName: 'file',
        }),
      ),
    ).toEqual({
      apiKey: 'json-key',
      endpoint: 'https://rembg.example/api/remove',
      fieldName: 'file',
    });
  });

  it('treats JSON without apiKey as retryable (secret not populated yet)', () => {
    expect(() => parseBackgroundRemovalSecret(JSON.stringify({ endpoint: 'https://x' }))).toThrow(
      RetryableProcessingError,
    );
  });
});

describe('loadBackgroundRemovalConfig', () => {
  const originalArn = process.env.BACKGROUND_REMOVAL_SECRET_ARN;
  const originalEndpoint = process.env.BACKGROUND_REMOVAL_ENDPOINT;

  afterEach(() => {
    if (originalArn === undefined) {
      delete process.env.BACKGROUND_REMOVAL_SECRET_ARN;
    } else {
      process.env.BACKGROUND_REMOVAL_SECRET_ARN = originalArn;
    }
    if (originalEndpoint === undefined) {
      delete process.env.BACKGROUND_REMOVAL_ENDPOINT;
    } else {
      process.env.BACKGROUND_REMOVAL_ENDPOINT = originalEndpoint;
    }
  });

  it('prefers BACKGROUND_REMOVAL_ENDPOINT over the secret endpoint', async () => {
    process.env.BACKGROUND_REMOVAL_SECRET_ARN = 'arn:secret';
    process.env.BACKGROUND_REMOVAL_ENDPOINT = 'https://env.example/remove';

    const config = await loadBackgroundRemovalConfig(async () =>
      JSON.stringify({
        apiKey: 'from-secret',
        endpoint: 'https://secret.example/remove',
      }),
    );

    expect(config).toEqual({
      apiKey: 'from-secret',
      endpoint: 'https://env.example/remove',
      fieldName: undefined,
    });
  });

  it('fails retryably when the secret ARN is missing', async () => {
    delete process.env.BACKGROUND_REMOVAL_SECRET_ARN;
    await expect(loadBackgroundRemovalConfig(async () => 'key')).rejects.toBeInstanceOf(
      RetryableProcessingError,
    );
  });

  it('fails retryably when neither env nor secret provides an endpoint', async () => {
    process.env.BACKGROUND_REMOVAL_SECRET_ARN = 'arn:secret';
    delete process.env.BACKGROUND_REMOVAL_ENDPOINT;
    await expect(loadBackgroundRemovalConfig(async () => 'plain-key')).rejects.toBeInstanceOf(
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
            throw new PermanentProcessingError('Background removal rejected the image (422)');
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

  it('does not call the live provider when a client is injected', async () => {
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
});

describe('createHttpBackgroundRemovalClient', () => {
  const config = {
    apiKey: 'test-key',
    endpoint: 'https://rembg.example/api/remove',
  };

  it('POSTs the image and returns PNG bytes', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => PNG.buffer,
    });

    const client = createHttpBackgroundRemovalClient(config, fetchImpl);
    await expect(client.removeBackground(ORIGINAL, 'image/jpeg')).resolves.toEqual(
      PNG,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      config.endpoint,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'X-Api-Key': 'test-key',
          Authorization: 'Bearer test-key',
        },
      }),
    );
  });

  it('maps 429 / 5xx to retryable and 4xx image errors to permanent', async () => {
    const retry = createHttpBackgroundRemovalClient(config, async () =>
      ({ ok: false, status: 503 }) as Response,
    );
    await expect(retry.removeBackground(ORIGINAL, 'image/jpeg')).rejects.toBeInstanceOf(
      RetryableProcessingError,
    );

    const permanent = createHttpBackgroundRemovalClient(config, async () =>
      ({ ok: false, status: 422 }) as Response,
    );
    await expect(permanent.removeBackground(ORIGINAL, 'image/jpeg')).rejects.toBeInstanceOf(
      PermanentProcessingError,
    );
  });

  it('maps network failures to retryable', async () => {
    const client = createHttpBackgroundRemovalClient(config, async () => {
      throw new Error('fetch failed');
    });
    await expect(client.removeBackground(ORIGINAL, 'image/jpeg')).rejects.toBeInstanceOf(
      RetryableProcessingError,
    );
  });
});
