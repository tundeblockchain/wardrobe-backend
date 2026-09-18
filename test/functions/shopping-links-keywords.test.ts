import {
  DEFAULT_OPENAI_SHOPPING_ENDPOINT,
  DEFAULT_OPENAI_SHOPPING_MODEL,
  createOpenAiKeywordExtractor,
  itemMetadataForKeywords,
  keywordsFromOpenAiResponse,
  parseOpenAiShoppingSecret,
  preferredItemImageKey,
  sanitizeKeywords,
} from '../../src/functions/shopping-links/keywords';
import { DynamoItem } from '../../src/shared/types';

function clothingItem(overrides: Partial<DynamoItem> = {}): DynamoItem {
  return {
    PK: 'WARDROBE#wd_1',
    SK: 'ITEM#item_1',
    entityType: 'ITEM',
    userId: 'uid',
    wardrobeId: 'wd_1',
    itemId: 'item_1',
    name: 'Black Nike T-Shirt',
    category: 'TOP',
    subcategory: 'TSHIRT',
    colours: ['BLACK'],
    brand: 'Nike',
    originalKey: 'users/uid/uploads/photo.jpg',
    processedKey: 'users/uid/items/item_1/processed.png',
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
    ...overrides,
  };
}

function openAiEnvelope(content: unknown) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return { choices: [{ message: { content: text } }] };
}

describe('parseOpenAiShoppingSecret', () => {
  const previousEndpoint = process.env.OPENAI_SHOPPING_ENDPOINT;
  const previousModel = process.env.OPENAI_SHOPPING_MODEL;

  afterEach(() => {
    if (previousEndpoint === undefined) {
      delete process.env.OPENAI_SHOPPING_ENDPOINT;
    } else {
      process.env.OPENAI_SHOPPING_ENDPOINT = previousEndpoint;
    }
    if (previousModel === undefined) {
      delete process.env.OPENAI_SHOPPING_MODEL;
    } else {
      process.env.OPENAI_SHOPPING_MODEL = previousModel;
    }
  });

  it('accepts a raw API key and defaults model/endpoint', () => {
    expect(parseOpenAiShoppingSecret(' sk-raw ')).toEqual({
      apiKey: 'sk-raw',
      model: DEFAULT_OPENAI_SHOPPING_MODEL,
      endpoint: DEFAULT_OPENAI_SHOPPING_ENDPOINT,
    });
  });

  it('accepts JSON apiKey / model / endpoint', () => {
    expect(
      parseOpenAiShoppingSecret(
        JSON.stringify({
          api_key: 'sk-json',
          model: 'gpt-4o',
          endpoint: 'https://openai.example/v1/chat/completions',
        }),
      ),
    ).toEqual({
      apiKey: 'sk-json',
      model: 'gpt-4o',
      endpoint: 'https://openai.example/v1/chat/completions',
    });
  });

  it('rejects empty, placeholder, and missing apiKey secrets', () => {
    expect(() => parseOpenAiShoppingSecret('')).toThrow('empty');
    expect(() => parseOpenAiShoppingSecret('placeholder-key')).toThrow('placeholder');
    expect(() =>
      parseOpenAiShoppingSecret(JSON.stringify({ model: 'gpt-4o-mini' })),
    ).toThrow('missing apiKey');
  });
});

describe('keywordsFromOpenAiResponse / sanitizeKeywords', () => {
  it('reads chat completions JSON keywords', () => {
    expect(
      keywordsFromOpenAiResponse(
        openAiEnvelope({
          keywords: ['Black Nike T-Shirt', 'mens black crew neck tee', 'Black Nike T-Shirt'],
        }),
      ),
    ).toEqual(['Black Nike T-Shirt', 'mens black crew neck tee']);
  });

  it('drops empty and overly long phrases', () => {
    expect(sanitizeKeywords(['', 'ok tee', 'x'.repeat(81)])).toEqual(['ok tee']);
  });
});

describe('item metadata + preferred image key', () => {
  it('prefers processedKey over originalKey', () => {
    expect(preferredItemImageKey(clothingItem())).toBe(
      'users/uid/items/item_1/processed.png',
    );
    expect(
      preferredItemImageKey(clothingItem({ processedKey: undefined })),
    ).toBe('users/uid/uploads/photo.jpg');
  });

  it('falls back to AI detections when user fields are missing', () => {
    expect(
      itemMetadataForKeywords(
        clothingItem({
          subcategory: undefined,
          colours: undefined,
          ai: { detectedSubcategory: 'HOODIE', detectedColours: ['NAVY'] },
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        subcategory: 'HOODIE',
        colours: ['NAVY'],
        brand: 'Nike',
      }),
    );
  });
});

describe('createOpenAiKeywordExtractor', () => {
  it('posts vision chat completions with injected secret and HTTP client', async () => {
    const httpPost = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(openAiEnvelope({ keywords: ['navy hoodie', 'zip hoodie'] })),
    });

    const extractor = createOpenAiKeywordExtractor({
      fetchSecret: async () => ({
        apiKey: 'sk-test',
        model: 'gpt-4o-mini',
        endpoint: DEFAULT_OPENAI_SHOPPING_ENDPOINT,
      }),
      httpPost,
    });

    const keywords = await extractor.extract({
      item: clothingItem(),
      image: { bytes: Buffer.from('jpeg'), contentType: 'image/jpeg' },
    });

    expect(keywords).toEqual(['navy hoodie', 'zip hoodie']);
    expect(httpPost).toHaveBeenCalledTimes(1);
    const [, init] = httpPost.mock.calls[0] as [
      string,
      { headers?: Record<string, string>; body?: string },
    ];
    expect(init.headers?.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body ?? '{}') as {
      messages: Array<{ content: unknown }>;
    };
    expect(body.messages[1].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text' }),
        expect.objectContaining({ type: 'image_url' }),
      ]),
    );
  });

  it('uses metadata only when no image is provided', async () => {
    const httpPost = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(openAiEnvelope({ keywords: ['black tee'] })),
    });
    const extractor = createOpenAiKeywordExtractor({
      fetchSecret: async () => ({
        apiKey: 'sk-test',
        model: 'gpt-4o-mini',
        endpoint: DEFAULT_OPENAI_SHOPPING_ENDPOINT,
      }),
      httpPost,
    });

    await extractor.extract({ item: clothingItem() });
    const [, init] = httpPost.mock.calls[0] as [string, { body?: string }];
    const body = JSON.parse(init.body ?? '{}') as {
      messages: Array<{ content: unknown }>;
    };
    expect(typeof body.messages[1].content).toBe('string');
  });

  it('includes model and OpenAI body on HTTP errors', async () => {
    const httpPost = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () =>
        JSON.stringify({
          error: { message: 'The model `gpt-4o-mini` does not exist', code: 'model_not_found' },
        }),
    });
    const extractor = createOpenAiKeywordExtractor({
      fetchSecret: async () => ({
        apiKey: 'sk-test',
        model: DEFAULT_OPENAI_SHOPPING_MODEL,
        endpoint: DEFAULT_OPENAI_SHOPPING_ENDPOINT,
      }),
      httpPost,
    });

    await expect(extractor.extract({ item: clothingItem() })).rejects.toThrow(
      /OpenAI shopping keywords HTTP 404 \(model=gpt-4\.1-mini\).*model_not_found/,
    );
  });

  it('maps abort to a timeout error with model', async () => {
    const abort = new Error('This operation was aborted');
    abort.name = 'AbortError';
    const httpPost = jest.fn().mockRejectedValue(abort);
    const extractor = createOpenAiKeywordExtractor({
      fetchSecret: async () => ({
        apiKey: 'sk-test',
        model: DEFAULT_OPENAI_SHOPPING_MODEL,
        endpoint: DEFAULT_OPENAI_SHOPPING_ENDPOINT,
      }),
      httpPost,
    });

    await expect(extractor.extract({ item: clothingItem() })).rejects.toMatchObject({
      name: 'UpstreamTimeoutError',
      message: expect.stringMatching(
        /OpenAI shopping keywords timed out after \d+ms \(model=gpt-4\.1-mini\)/,
      ),
      timeoutMs: expect.any(Number),
      model: DEFAULT_OPENAI_SHOPPING_MODEL,
    });
  });
});
