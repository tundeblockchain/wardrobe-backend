import { OutfitRecommender, RecommendableItem } from '../../src/functions/recommendations/strategy';
import {
  DEFAULT_OPENAI_CHAT_ENDPOINT,
  DEFAULT_OPENAI_MODEL,
  createOpenAiOutfitRecommender,
  extractOpenAiMessageContent,
  parseOpenAiRecommenderSecret,
  recommendationsFromOpenAiResponse,
  sanitizeRecommendations,
} from '../../src/functions/recommendations/openai-recommender';

function item(
  itemId: string,
  slot: RecommendableItem['slot'],
  colours: RecommendableItem['colours'] = [],
): RecommendableItem {
  return { itemId, name: itemId, slot, colours };
}

function openAiEnvelope(content: unknown) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return {
    choices: [{ message: { content: text } }],
  };
}

describe('parseOpenAiRecommenderSecret', () => {
  const previousEndpoint = process.env.AI_RECOMMENDER_ENDPOINT;
  const previousModel = process.env.OPENAI_MODEL;

  afterEach(() => {
    if (previousEndpoint === undefined) {
      delete process.env.AI_RECOMMENDER_ENDPOINT;
    } else {
      process.env.AI_RECOMMENDER_ENDPOINT = previousEndpoint;
    }
    if (previousModel === undefined) {
      delete process.env.OPENAI_MODEL;
    } else {
      process.env.OPENAI_MODEL = previousModel;
    }
  });

  it('accepts JSON apiKey and defaults model/endpoint to OpenAI chat', () => {
    expect(
      parseOpenAiRecommenderSecret(JSON.stringify({ apiKey: 'sk-test' })),
    ).toEqual({
      apiKey: 'sk-test',
      model: DEFAULT_OPENAI_MODEL,
      endpoint: DEFAULT_OPENAI_CHAT_ENDPOINT,
    });
  });

  it('accepts a raw API key', () => {
    expect(parseOpenAiRecommenderSecret(' sk-raw ')).toEqual({
      apiKey: 'sk-raw',
      model: DEFAULT_OPENAI_MODEL,
      endpoint: DEFAULT_OPENAI_CHAT_ENDPOINT,
    });
  });

  it('reads model and endpoint from JSON', () => {
    expect(
      parseOpenAiRecommenderSecret(
        JSON.stringify({
          api_key: 'sk-json',
          model: 'gpt-4.1-mini',
          endpoint: 'https://openai.example/v1/chat/completions',
        }),
      ),
    ).toEqual({
      apiKey: 'sk-json',
      model: 'gpt-4.1-mini',
      endpoint: 'https://openai.example/v1/chat/completions',
    });
  });

  it('uses env overrides when the secret is a raw key', () => {
    process.env.AI_RECOMMENDER_ENDPOINT = 'https://proxy.example/chat';
    process.env.OPENAI_MODEL = 'gpt-4o';
    expect(parseOpenAiRecommenderSecret('sk-env')).toEqual({
      apiKey: 'sk-env',
      model: 'gpt-4o',
      endpoint: 'https://proxy.example/chat',
    });
  });

  it('rejects an empty secret or missing apiKey', () => {
    expect(() => parseOpenAiRecommenderSecret('')).toThrow(
      'AI recommender secret is empty',
    );
    expect(() => parseOpenAiRecommenderSecret(JSON.stringify({ model: 'gpt-4o-mini' }))).toThrow(
      'AI recommender secret is missing apiKey',
    );
  });
});

describe('extractOpenAiMessageContent / recommendationsFromOpenAiResponse', () => {
  it('reads chat completions content as a Flutter envelope', () => {
    expect(
      recommendationsFromOpenAiResponse(
        openAiEnvelope({
          recommendations: [
            { name: 'Friday', items: [{ itemId: 'item_1', slot: 'TOP' }] },
          ],
        }),
      ),
    ).toEqual([
      { name: 'Friday', items: [{ itemId: 'item_1', slot: 'TOP' }] },
    ]);
  });

  it('strips markdown fences around JSON content', () => {
    expect(
      recommendationsFromOpenAiResponse({
        choices: [
          {
            message: {
              content: '```json\n{"recommendations":[{"items":[{"itemId":"item_1","slot":"DRESS"}]}]}\n```',
            },
          },
        ],
      }),
    ).toEqual([{ items: [{ itemId: 'item_1', slot: 'DRESS' }] }]);
  });

  it('joins array content parts', () => {
    expect(
      extractOpenAiMessageContent({
        choices: [
          {
            message: {
              content: [{ type: 'text', text: '{"recommendations":[]}' }],
            },
          },
        ],
      }),
    ).toBe('{"recommendations":[]}');
  });

  it('returns undefined for an unusable payload', () => {
    expect(recommendationsFromOpenAiResponse({ choices: [] })).toBeUndefined();
    expect(
      recommendationsFromOpenAiResponse(openAiEnvelope({ outfits: [] })),
    ).toBeUndefined();
  });
});

describe('sanitizeRecommendations', () => {
  const wardrobe = [
    item('item_top', 'TOP', ['NAVY']),
    item('item_bottom', 'BOTTOM', ['BEIGE']),
    item('item_shoes', 'SHOES', ['BROWN']),
  ];

  it('drops invented item IDs and forces wardrobe slots', () => {
    expect(
      sanitizeRecommendations(
        [
          {
            name: 'Invented look',
            items: [
              { itemId: 'item_top', slot: 'BOTTOM' },
              { itemId: 'item_bottom', slot: 'TOP' },
              { itemId: 'item_ghost', slot: 'SHOES' },
            ],
          },
        ],
        wardrobe,
      ),
    ).toEqual([
      {
        name: 'Invented look',
        items: [
          { itemId: 'item_top', slot: 'TOP' },
          { itemId: 'item_bottom', slot: 'BOTTOM' },
        ],
      },
    ]);
  });

  it('skips looks that are not wearable after sanitizing', () => {
    expect(
      sanitizeRecommendations(
        [{ items: [{ itemId: 'item_shoes', slot: 'SHOES' }] }],
        wardrobe,
      ),
    ).toEqual([]);
  });
});

describe('createOpenAiOutfitRecommender', () => {
  const wardrobe = [
    item('item_top', 'TOP', ['NAVY']),
    item('item_bottom', 'BOTTOM', ['BEIGE']),
    item('item_shoes', 'SHOES', ['BROWN']),
  ];

  it('posts a chat completion and maps the Flutter-shaped response', async () => {
    const httpPost = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(
          openAiEnvelope({
            recommendations: [
              {
                name: 'Navy + Beige look',
                items: [
                  { itemId: 'item_top', slot: 'TOP' },
                  { itemId: 'item_bottom', slot: 'BOTTOM' },
                  { itemId: 'item_shoes', slot: 'SHOES' },
                ],
              },
            ],
          }),
        ),
    }));

    const recommender = createOpenAiOutfitRecommender({
      fetchSecret: async () => ({
        apiKey: 'sk-test',
        model: DEFAULT_OPENAI_MODEL,
        endpoint: DEFAULT_OPENAI_CHAT_ENDPOINT,
      }),
      httpPost,
    });

    const recommendations = await recommender.recommend(wardrobe);

    expect(recommendations).toEqual([
      {
        name: 'Navy + Beige look',
        items: [
          { itemId: 'item_top', slot: 'TOP' },
          { itemId: 'item_bottom', slot: 'BOTTOM' },
          { itemId: 'item_shoes', slot: 'SHOES' },
        ],
      },
    ]);
    expect(httpPost).toHaveBeenCalledWith(
      DEFAULT_OPENAI_CHAT_ENDPOINT,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test',
          'Content-Type': 'application/json',
        }),
      }),
    );
    const posted = (
      httpPost.mock.calls as unknown as Array<[string, { body?: string }]>
    )[0]?.[1];
    const body = JSON.parse(posted?.body ?? '{}') as {
      model: string;
      messages: Array<{ role: string }>;
      response_format: { type: string };
    };
    expect(body.model).toBe(DEFAULT_OPENAI_MODEL);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages.map((message) => message.role)).toEqual(['system', 'user']);
  });

  it('returns an empty list without calling OpenAI when items are insufficient', async () => {
    const httpPost = jest.fn();
    const fetchSecret = jest.fn();
    const recommender = createOpenAiOutfitRecommender({ fetchSecret, httpPost });

    await expect(
      recommender.recommend([item('item_top', 'TOP', ['BLACK'])]),
    ).resolves.toEqual([]);
    expect(httpPost).not.toHaveBeenCalled();
    expect(fetchSecret).not.toHaveBeenCalled();
  });

  it('falls back to rule-based on HTTP failure (no 500)', async () => {
    const fallback: OutfitRecommender = {
      recommend: jest.fn(async () => [
        { name: 'Fallback look', items: [{ itemId: 'item_top', slot: 'TOP' as const }] },
      ]),
    };
    const httpPost = jest.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => 'unavailable',
    }));

    const recommender = createOpenAiOutfitRecommender({
      fetchSecret: async () => ({
        apiKey: 'sk-test',
        model: DEFAULT_OPENAI_MODEL,
        endpoint: DEFAULT_OPENAI_CHAT_ENDPOINT,
      }),
      httpPost,
      fallback,
    });

    await expect(recommender.recommend(wardrobe)).resolves.toEqual([
      { name: 'Fallback look', items: [{ itemId: 'item_top', slot: 'TOP' }] },
    ]);
    expect(fallback.recommend).toHaveBeenCalledWith(wardrobe);
  });

  it('falls back to rule-based on a missing secret or parse failure', async () => {
    const fallback: OutfitRecommender = {
      recommend: jest.fn(async () => []),
    };

    const missingSecret = createOpenAiOutfitRecommender({
      fetchSecret: async () => {
        throw new Error('AI_RECOMMENDER_SECRET_ARN is not configured');
      },
      httpPost: jest.fn(),
      fallback,
    });
    await expect(missingSecret.recommend(wardrobe)).resolves.toEqual([]);

    const badJson = createOpenAiOutfitRecommender({
      fetchSecret: async () => ({
        apiKey: 'sk-test',
        model: DEFAULT_OPENAI_MODEL,
        endpoint: DEFAULT_OPENAI_CHAT_ENDPOINT,
      }),
      httpPost: async () => ({
        ok: true,
        status: 200,
        text: async () => 'not-json',
      }),
      fallback,
    });
    await expect(badJson.recommend(wardrobe)).resolves.toEqual([]);
    expect(fallback.recommend).toHaveBeenCalledTimes(2);
  });

  it('falls back when OpenAI returns only invented item IDs', async () => {
    const fallback: OutfitRecommender = {
      recommend: jest.fn(async () => [
        {
          name: 'Rule look',
          items: [
            { itemId: 'item_top', slot: 'TOP' as const },
            { itemId: 'item_bottom', slot: 'BOTTOM' as const },
          ],
        },
      ]),
    };

    const recommender = createOpenAiOutfitRecommender({
      fetchSecret: async () => ({
        apiKey: 'sk-test',
        model: DEFAULT_OPENAI_MODEL,
        endpoint: DEFAULT_OPENAI_CHAT_ENDPOINT,
      }),
      httpPost: async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            openAiEnvelope({
              recommendations: [
                { items: [{ itemId: 'item_ghost', slot: 'TOP' }] },
              ],
            }),
          ),
      }),
      fallback,
    });

    await expect(recommender.recommend(wardrobe)).resolves.toEqual([
      {
        name: 'Rule look',
        items: [
          { itemId: 'item_top', slot: 'TOP' },
          { itemId: 'item_bottom', slot: 'BOTTOM' },
        ],
      },
    ]);
  });

  it('uses the built-in rule-based fallback when none is injected', async () => {
    const recommender = createOpenAiOutfitRecommender({
      fetchSecret: async () => {
        throw new Error('placeholder secret');
      },
      httpPost: jest.fn(),
    });

    const recommendations = await recommender.recommend(wardrobe);
    expect(recommendations.length).toBeGreaterThan(0);
    expect(recommendations[0].items).toEqual(
      expect.arrayContaining([
        { itemId: 'item_top', slot: 'TOP' },
        { itemId: 'item_bottom', slot: 'BOTTOM' },
      ]),
    );
  });
});
