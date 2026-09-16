import {
  DEFAULT_BRIGHT_DATA_ENDPOINT,
  buildGoogleShoppingUrl,
  buildShoppingQuery,
  mapSerpToLinks,
  parseBrightDataSecret,
} from '../../src/functions/shopping-links/serp';

describe('parseBrightDataSecret', () => {
  it('reads apiToken, zone, and optional targeting fields', () => {
    expect(
      parseBrightDataSecret(
        JSON.stringify({
          apiToken: 'brd-token',
          zone: 'serp_api1',
          customer: 'cust_1',
          country: 'us',
          language: 'en',
        }),
      ),
    ).toEqual({
      apiToken: 'brd-token',
      zone: 'serp_api1',
      endpoint: DEFAULT_BRIGHT_DATA_ENDPOINT,
      customer: 'cust_1',
      country: 'us',
      language: 'en',
    });
  });

  it('accepts aliases and defaults country/language to gb/en', () => {
    expect(
      parseBrightDataSecret(
        JSON.stringify({ api_key: 'tok', zoneName: 'serp_api1' }),
      ),
    ).toEqual({
      apiToken: 'tok',
      zone: 'serp_api1',
      endpoint: DEFAULT_BRIGHT_DATA_ENDPOINT,
      country: 'gb',
      language: 'en',
    });
  });

  it('rejects raw strings, placeholders, and missing fields', () => {
    expect(() => parseBrightDataSecret('raw-token')).toThrow('JSON');
    expect(() => parseBrightDataSecret('{"apiToken":"placeholder","zone":"serp"}')).toThrow(
      'placeholder',
    );
    expect(() => parseBrightDataSecret(JSON.stringify({ zone: 'serp_api1' }))).toThrow(
      'apiToken',
    );
    expect(() => parseBrightDataSecret(JSON.stringify({ apiToken: 'tok' }))).toThrow(
      'zone',
    );
  });
});

describe('mapSerpToLinks', () => {
  it('maps Bright Data shopping products onto the Flutter Link DTO', () => {
    const links = mapSerpToLinks(
      {
        shopping: [
          {
            title: 'Nike Club Tee',
            link: 'https://www.nike.com/tee',
            shop: 'Nike',
            price: '£24.99',
            image: 'https://img.example/tee.jpg',
          },
          {
            title: 'Crew Neck',
            url: 'https://shop.example/crew',
            merchant: { name: 'ASOS' },
            price: { raw: '$19.00', currency: 'USD' },
          },
        ],
      },
      8,
      'black t-shirt',
    );

    expect(links).toEqual([
      {
        title: 'Nike Club Tee',
        url: 'https://www.nike.com/tee',
        merchant: 'Nike',
        price: '£24.99',
        currency: 'GBP',
        imageUrl: 'https://img.example/tee.jpg',
      },
      {
        title: 'Crew Neck',
        url: 'https://shop.example/crew',
        merchant: 'ASOS',
        price: '$19.00',
        currency: 'USD',
      },
    ]);
  });

  it('soft-omits data: images and synthesizes a Google Shopping url when link is missing', () => {
    const links = mapSerpToLinks(
      {
        shopping: [
          {
            title: 'Plain Tee',
            shop: 'Walmart',
            price: '$6.99',
            image: 'data:image/jpeg;base64,/9j/abc',
          },
        ],
      },
      8,
      'plain tee',
    );

    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({
      title: 'Plain Tee',
      url: 'https://www.google.com/search?tbm=shop&q=Plain+Tee',
      merchant: 'Walmart',
      price: '$6.99',
      currency: 'USD',
    });
    expect(links[0]).not.toHaveProperty('imageUrl');
  });

  it('caps results and skips rows without a title', () => {
    const links = mapSerpToLinks(
      {
        organic: [
          { link: 'https://x.example' },
          { title: 'One', url: 'https://a.example' },
          { title: 'Two', url: 'https://b.example' },
          { title: 'Three', url: 'https://c.example' },
        ],
      },
      2,
      'q',
    );
    expect(links.map((link) => link.title)).toEqual(['One', 'Two']);
  });
});

describe('query builders', () => {
  it('uses the first keyword as the SERP query', () => {
    expect(buildShoppingQuery(['black nike tee', 'crew neck'], 'ignored')).toBe(
      'black nike tee',
    );
  });

  it('builds a Google Shopping URL with brd_json and geo', () => {
    const url = buildGoogleShoppingUrl('black tee', {
      country: 'gb',
      language: 'en',
    });
    expect(url).toContain('tbm=shop');
    expect(url).toContain('udm=28');
    expect(url).toContain('brd_json=1');
    expect(url).toContain('gl=gb');
    expect(url).toContain('hl=en');
  });
});
