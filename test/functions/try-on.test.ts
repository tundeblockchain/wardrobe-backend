import { PermanentProcessingError, RetryableProcessingError } from '../../src/functions/processing/errors';
import {
  createGeminiTryOnClient,
  DEFAULT_GEMINI_MODEL,
  geminiGenerateContentUrl,
  loadTryOnConfig,
  parseTryOnSecret,
  runOutfitTryOn,
} from '../../src/functions/processing/try-on';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0x01]);
const PNG_BASE64 = Buffer.from(PNG).toString('base64');
const DEFAULT_ENDPOINT = geminiGenerateContentUrl(DEFAULT_GEMINI_MODEL);

const USER_ID = 'firebase-uid-owner';
const OUTFIT_ID = 'outfit_xyz123ab';
const PROFILE_KEY = 'shared/ai-profiles/generic/alex/front.jpg';
const GARMENT_KEY = `users/${USER_ID}/items/item_top123abcd/processed.png`;
const RENDER_KEY = `users/${USER_ID}/outfits/${OUTFIT_ID}/render.png`;

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

describe('parseTryOnSecret', () => {
  it('accepts a plain Gemini API key and fills default model + endpoint', () => {
    expect(parseTryOnSecret('  gemini-key  ')).toEqual({
      apiKey: 'gemini-key',
      model: DEFAULT_GEMINI_MODEL,
      endpoint: DEFAULT_ENDPOINT,
    });
  });

  it('accepts JSON with apiKey, model, and endpoint', () => {
    expect(
      parseTryOnSecret(
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

  it('treats a missing apiKey as retryable so an empty placeholder can be filled', () => {
    expect(() => parseTryOnSecret('{}')).toThrow(RetryableProcessingError);
  });
});

describe('loadTryOnConfig', () => {
  const originalArn = process.env.GEMINI_TRY_ON_SECRET_ARN;
  const originalModel = process.env.GEMINI_TRY_ON_MODEL;
  const originalEndpoint = process.env.GEMINI_TRY_ON_ENDPOINT;

  afterEach(() => {
    if (originalArn === undefined) {
      delete process.env.GEMINI_TRY_ON_SECRET_ARN;
    } else {
      process.env.GEMINI_TRY_ON_SECRET_ARN = originalArn;
    }
    if (originalModel === undefined) {
      delete process.env.GEMINI_TRY_ON_MODEL;
    } else {
      process.env.GEMINI_TRY_ON_MODEL = originalModel;
    }
    if (originalEndpoint === undefined) {
      delete process.env.GEMINI_TRY_ON_ENDPOINT;
    } else {
      process.env.GEMINI_TRY_ON_ENDPOINT = originalEndpoint;
    }
  });

  it('throws retryable when the secret ARN is missing', async () => {
    delete process.env.GEMINI_TRY_ON_SECRET_ARN;
    await expect(loadTryOnConfig(async () => 'key')).rejects.toThrow(
      RetryableProcessingError,
    );
  });

  it('lets GEMINI_TRY_ON_MODEL override the secret model', async () => {
    process.env.GEMINI_TRY_ON_SECRET_ARN = 'arn:secret';
    process.env.GEMINI_TRY_ON_MODEL = 'gemini-override';
    delete process.env.GEMINI_TRY_ON_ENDPOINT;

    await expect(loadTryOnConfig(async () => 'plain-key')).resolves.toEqual({
      apiKey: 'plain-key',
      model: 'gemini-override',
      endpoint: geminiGenerateContentUrl('gemini-override'),
    });
  });
});

describe('runOutfitTryOn', () => {
  it('reads profile + garment images, calls Gemini, and writes render.png', async () => {
    const gets: string[] = [];
    const puts: Array<{ key: string; type: string }> = [];

    const imageKey = await runOutfitTryOn(
      {
        userId: USER_ID,
        outfitId: OUTFIT_ID,
        profileImageKeys: [PROFILE_KEY],
        garmentImages: [{ slot: 'TOP', objectKey: GARMENT_KEY }],
      },
      {
        store: {
          async getObject(objectKey) {
            gets.push(objectKey);
            return { bytes: JPEG, contentType: 'image/jpeg' };
          },
          async putObject(objectKey, _bytes, contentType) {
            puts.push({ key: objectKey, type: contentType });
          },
        },
        client: {
          async render() {
            return PNG;
          },
        },
      },
    );

    expect(imageKey).toBe(RENDER_KEY);
    expect(gets).toEqual([PROFILE_KEY, GARMENT_KEY]);
    expect(puts).toEqual([{ key: RENDER_KEY, type: 'image/png' }]);
  });

  it('fails permanently when the profile has no reference images', async () => {
    await expect(
      runOutfitTryOn(
        {
          userId: USER_ID,
          outfitId: OUTFIT_ID,
          profileImageKeys: [],
          garmentImages: [{ slot: 'TOP', objectKey: GARMENT_KEY }],
        },
        {
          client: { async render() { return PNG; } },
          store: {
            async getObject() {
              return { bytes: JPEG, contentType: 'image/jpeg' };
            },
            async putObject() {},
          },
        },
      ),
    ).rejects.toThrow(PermanentProcessingError);
  });
});

describe('createGeminiTryOnClient', () => {
  it('posts generateContent with labeled inline images and extracts the PNG', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      text: async () => geminiImageResponse(),
    }));

    const client = createGeminiTryOnClient(
      {
        apiKey: 'gemini-key',
        model: DEFAULT_GEMINI_MODEL,
        endpoint: DEFAULT_ENDPOINT,
      },
      fetchImpl as unknown as typeof fetch,
    );

    await expect(
      client.render([
        { label: 'Person reference 1', bytes: JPEG, contentType: 'image/jpeg' },
        { label: 'Garment TOP', bytes: PNG, contentType: 'image/png' },
      ]),
    ).resolves.toEqual(PNG);

    expect(fetchImpl).toHaveBeenCalledWith(
      DEFAULT_ENDPOINT,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': 'gemini-key',
        },
      }),
    );
    const body = JSON.parse(
      (fetchImpl.mock.calls[0][1] as { body: string }).body,
    ) as { contents: Array<{ parts: unknown[] }> };
    expect(body.contents[0].parts.length).toBe(5);
  });

  it('marks safety blocks as permanent failures', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }),
    }));

    const client = createGeminiTryOnClient(
      {
        apiKey: 'gemini-key',
        model: DEFAULT_GEMINI_MODEL,
        endpoint: DEFAULT_ENDPOINT,
      },
      fetchImpl as unknown as typeof fetch,
    );

    await expect(
      client.render([
        { label: 'Person reference 1', bytes: JPEG, contentType: 'image/jpeg' },
      ]),
    ).rejects.toThrow(PermanentProcessingError);
  });

  it('retries 429 / 5xx Gemini responses', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    }));

    const client = createGeminiTryOnClient(
      {
        apiKey: 'gemini-key',
        model: DEFAULT_GEMINI_MODEL,
        endpoint: DEFAULT_ENDPOINT,
      },
      fetchImpl as unknown as typeof fetch,
    );

    await expect(
      client.render([
        { label: 'Person reference 1', bytes: JPEG, contentType: 'image/jpeg' },
      ]),
    ).rejects.toThrow(RetryableProcessingError);
  });
});
