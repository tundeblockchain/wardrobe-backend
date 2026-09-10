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
const PROFILE_KEY = 'shared/ai-profiles/generic/alex/front.png';
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
  it('defaults try-on to gemini-3.1-flash-image, not legacy 2.5 flash-image', () => {
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-3.1-flash-image');
    expect(DEFAULT_GEMINI_MODEL).not.toBe('gemini-2.5-flash-image');
  });

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
      endpoint: geminiGenerateContentUrl('gemini-3.1-flash-image'),
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

  it('accepts a JPEG from Gemini 3.1 flash-image and stores it as image/jpeg', async () => {
    const puts: Array<{ key: string; type: string }> = [];

    await runOutfitTryOn(
      {
        userId: USER_ID,
        outfitId: OUTFIT_ID,
        profileImageKeys: [PROFILE_KEY],
        garmentImages: [{ slot: 'TOP', objectKey: GARMENT_KEY }],
      },
      {
        store: {
          async getObject() {
            return { bytes: JPEG, contentType: 'image/jpeg' };
          },
          async putObject(objectKey, _bytes, contentType) {
            puts.push({ key: objectKey, type: contentType });
          },
        },
        client: {
          async render() {
            return JPEG;
          },
        },
      },
    );

    expect(puts).toEqual([{ key: RENDER_KEY, type: 'image/jpeg' }]);
  });

  it('fails permanently when Gemini returns non-image bytes', async () => {
    await expect(
      runOutfitTryOn(
        {
          userId: USER_ID,
          outfitId: OUTFIT_ID,
          profileImageKeys: [PROFILE_KEY],
          garmentImages: [{ slot: 'TOP', objectKey: GARMENT_KEY }],
        },
        {
          store: {
            async getObject() {
              return { bytes: JPEG, contentType: 'image/jpeg' };
            },
            async putObject() {},
          },
          client: {
            async render() {
              return Uint8Array.from([0x00, 0x01, 0x02]);
            },
          },
        },
      ),
    ).rejects.toThrow('Outfit try-on did not return a PNG or JPEG image.');
  });

  it('grounds Gemini in outfit categories and omits jeans when a dress is present', async () => {
    const dressKey = `users/${USER_ID}/items/item_dress/processed.png`;
    const jeansKey = `users/${USER_ID}/items/item_jeans/processed.png`;
    const gets: string[] = [];
    let renderedLabels: string[] = [];
    let renderedPrompt = '';

    await runOutfitTryOn(
      {
        userId: USER_ID,
        outfitId: OUTFIT_ID,
        profileImageKeys: [PROFILE_KEY],
        garmentImages: [
          {
            slot: 'DRESS',
            objectKey: dressKey,
            category: 'DRESS',
            subcategory: 'DRESS',
            name: 'Midi dress',
          },
          {
            slot: 'BOTTOM',
            objectKey: jeansKey,
            category: 'BOTTOM',
            subcategory: 'JEANS',
            name: 'Blue jeans',
          },
        ],
      },
      {
        store: {
          async getObject(objectKey) {
            gets.push(objectKey);
            return { bytes: JPEG, contentType: 'image/jpeg' };
          },
          async putObject() {},
        },
        client: {
          async render(images, prompt) {
            renderedLabels = images.map((image) => image.label);
            renderedPrompt = prompt ?? '';
            return PNG;
          },
        },
      },
    );

    expect(gets).toEqual([PROFILE_KEY, dressKey]);
    expect(gets).not.toContain(jeansKey);
    expect(renderedLabels).toEqual([
      'Person identity reference — use for face and body only, not as the output canvas',
      'Garment appearance reference — slot=DRESS; category=DRESS; subcategory=DRESS; name=Midi dress — reconstruct on the body, do not paste this image',
    ]);
    expect(renderedPrompt).toContain('slot=DRESS; category=DRESS; subcategory=DRESS; name=Midi dress');
    expect(renderedPrompt).toContain('slot=BOTTOM; category=BOTTOM; subcategory=JEANS; name=Blue jeans');
    expect(renderedPrompt).toContain('do not put jeans on a dress');
    expect(renderedPrompt).toContain('Do not put jeans on a dress.');
    expect(renderedPrompt).toContain('Do not overlay, paste, collage, or composite');
  });

  it('includes AI profile body context in the Gemini prompt and omits empty fields', async () => {
    let renderedPrompt = '';

    await runOutfitTryOn(
      {
        userId: USER_ID,
        outfitId: OUTFIT_ID,
        profileImageKeys: [PROFILE_KEY],
        garmentImages: [{ slot: 'TOP', objectKey: GARMENT_KEY, category: 'TOP' }],
        profileBody: {
          heightCm: 175,
          clothingSize: 'M',
          braSize: '34B',
          ageYears: 28,
        },
      },
      {
        store: {
          async getObject() {
            return { bytes: JPEG, contentType: 'image/jpeg' };
          },
          async putObject() {},
        },
        client: {
          async render(_images, prompt) {
            renderedPrompt = prompt ?? '';
            return PNG;
          },
        },
      },
    );

    expect(renderedPrompt).toContain('- height: 175 cm');
    expect(renderedPrompt).toContain('- clothing size: M');
    expect(renderedPrompt).toContain('- bra size: 34B');
    expect(renderedPrompt).toContain('- age: 28 years');
    expect(renderedPrompt).not.toContain('weight');
    expect(renderedPrompt).not.toContain('bust');
  });

  it('does not fail try-on when profile body context is omitted', async () => {
    let renderedPrompt = '';

    await runOutfitTryOn(
      {
        userId: USER_ID,
        outfitId: OUTFIT_ID,
        profileImageKeys: [PROFILE_KEY],
        garmentImages: [{ slot: 'TOP', objectKey: GARMENT_KEY }],
      },
      {
        store: {
          async getObject() {
            return { bytes: JPEG, contentType: 'image/jpeg' };
          },
          async putObject() {},
        },
        client: {
          async render(_images, prompt) {
            renderedPrompt = prompt ?? '';
            return PNG;
          },
        },
      },
    );

    expect(renderedPrompt).not.toContain('Person body context');
  });

  it('sends only the frontal profile image when several references exist', async () => {
    const sideKey = 'shared/ai-profiles/generic/alex/side.png';
    const gets: string[] = [];

    await runOutfitTryOn(
      {
        userId: USER_ID,
        outfitId: OUTFIT_ID,
        profileImageKeys: [sideKey, PROFILE_KEY],
        garmentImages: [{ slot: 'TOP', objectKey: GARMENT_KEY }],
      },
      {
        store: {
          async getObject(objectKey) {
            gets.push(objectKey);
            return { bytes: JPEG, contentType: 'image/jpeg' };
          },
          async putObject() {},
        },
        client: {
          async render() {
            return PNG;
          },
        },
      },
    );

    expect(gets).toEqual([PROFILE_KEY, GARMENT_KEY]);
    expect(gets).not.toContain(sideKey);
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

    const prompt =
      'Wear only the listed outfit pieces. Do not put jeans on a dress.';
    await expect(
      client.render(
        [
          { label: 'Person reference 1', bytes: JPEG, contentType: 'image/jpeg' },
          {
            label: 'Garment slot=TOP; category=TOP; subcategory=TSHIRT',
            bytes: PNG,
            contentType: 'image/png',
          },
        ],
        prompt,
      ),
    ).resolves.toEqual(PNG);

    expect(fetchImpl).toHaveBeenCalledWith(
      `${DEFAULT_ENDPOINT}?key=gemini-key`,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
      }),
    );
    const fetchCall = fetchImpl.mock.calls[0] as unknown as [
      string,
      { body?: string },
    ];
    const body = JSON.parse(fetchCall[1]?.body ?? '{}') as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
      generationConfig?: {
        responseModalities?: string[];
        imageConfig?: { aspectRatio?: string; imageSize?: string };
      };
    };
    expect(body.contents[0].parts.length).toBe(5);
    expect(body.contents[0].parts[0]).toEqual({
      text: 'Person reference 1',
    });
    expect(body.contents[0].parts[2]).toEqual({
      text: 'Garment slot=TOP; category=TOP; subcategory=TSHIRT',
    });
    expect(body.contents[0].parts[4]).toEqual({ text: prompt });
    expect(body.generationConfig).toEqual({
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '3:4', imageSize: '1K' },
    });
  });

  it('extracts a JPEG when Gemini 3.1 flash-image returns image/jpeg', async () => {
    const jpegBase64 = Buffer.from(JPEG).toString('base64');
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { inlineData: { mimeType: 'image/jpeg', data: jpegBase64 } },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        }),
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
      client.render(
        [{ label: 'Person reference 1', bytes: JPEG, contentType: 'image/jpeg' }],
        'Generate a new fashion photograph.',
      ),
    ).resolves.toEqual(JPEG);
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
