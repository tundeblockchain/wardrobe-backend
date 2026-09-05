import {
  createHttpOutfitRecommender,
  extractRecommendations,
  parseRecommenderSecret,
} from '../../src/functions/recommendations/http-recommender';

describe('parseRecommenderSecret', () => {
  const previousEndpoint = process.env.AI_RECOMMENDER_ENDPOINT;

  afterEach(() => {
    if (previousEndpoint === undefined) {
      delete process.env.AI_RECOMMENDER_ENDPOINT;
    } else {
      process.env.AI_RECOMMENDER_ENDPOINT = previousEndpoint;
    }
  });

  it('accepts JSON apiKey + endpoint', () => {
    expect(
      parseRecommenderSecret(
        JSON.stringify({ apiKey: 'placeholder-key', endpoint: 'https://recommender.example' }),
      ),
    ).toEqual({
      apiKey: 'placeholder-key',
      endpoint: 'https://recommender.example',
    });
  });

  it('accepts a raw key when AI_RECOMMENDER_ENDPOINT is set', () => {
    process.env.AI_RECOMMENDER_ENDPOINT = 'https://recommender.example';
    expect(parseRecommenderSecret(' raw-key ')).toEqual({
      apiKey: 'raw-key',
      endpoint: 'https://recommender.example',
    });
  });

  it('rejects an empty secret', () => {
    expect(() => parseRecommenderSecret('')).toThrow('AI recommender secret is empty');
  });
});

describe('extractRecommendations', () => {
  it('reads a Flutter-shaped envelope', () => {
    expect(
      extractRecommendations({
        recommendations: [
          { name: 'Friday', items: [{ itemId: 'item_1', slot: 'TOP' }] },
        ],
      }),
    ).toEqual([
      { name: 'Friday', items: [{ itemId: 'item_1', slot: 'TOP' }] },
    ]);
  });

  it('returns undefined for an unusable payload', () => {
    expect(extractRecommendations({ outfits: [] })).toBeUndefined();
  });
});

describe('createHttpOutfitRecommender', () => {
  it('posts wardrobe items to the configured endpoint with injected deps', async () => {
    const httpPost = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          recommendations: [
            { name: 'Vendor look', items: [{ itemId: 'item_1', slot: 'DRESS' }] },
          ],
        }),
    }));

    const recommender = createHttpOutfitRecommender({
      fetchSecret: async () => ({
        apiKey: 'placeholder-key',
        endpoint: 'https://recommender.example',
      }),
      httpPost,
    });

    const recommendations = await recommender.recommend([
      { itemId: 'item_1', name: 'Dress', slot: 'DRESS', colours: ['BLACK'] },
    ]);

    expect(recommendations).toEqual([
      { name: 'Vendor look', items: [{ itemId: 'item_1', slot: 'DRESS' }] },
    ]);
    expect(httpPost).toHaveBeenCalledWith(
      'https://recommender.example',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer placeholder-key',
        }),
      }),
    );
  });
});
