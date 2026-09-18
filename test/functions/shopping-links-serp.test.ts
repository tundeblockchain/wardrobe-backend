import {
  BRIGHT_DATA_BRD_JSON,
  BRIGHT_DATA_SERP_FORMAT,
  BrightDataSerpError,
  DEFAULT_BRIGHT_DATA_ENDPOINT,
  buildGoogleShoppingUrl,
  buildShoppingQuery,
  createBrightDataSerpClient,
  mapSerpToLinks,
  parseBrightDataSecret,
} from '../../src/functions/shopping-links/serp';
import {
  headerValue,
  redactSecretMaterial,
  truncateUpstreamBody,
} from '../../src/functions/shopping-links/http';

const SECRET = {
  apiToken: 'brd-token-secret-value',
  zone: 'serp_api1',
  endpoint: DEFAULT_BRIGHT_DATA_ENDPOINT,
  country: 'gb',
  language: 'en',
};

function shoppingJson(title = 'Nike Club Tee') {
  return {
    general: { search_type: 'shopping', query: 'black tee' },
    shopping: [
      {
        title,
        link: 'https://www.nike.com/tee',
        shop: 'Nike',
        price: '£24.99',
        image: 'https://img.example/tee.jpg',
      },
    ],
  };
}

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

  it('builds a Google Shopping URL with tbm=shop and brd_json=json (not udm=28)', () => {
    const url = buildGoogleShoppingUrl('black tee', {
      country: 'gb',
      language: 'en',
    });
    expect(url).toContain('tbm=shop');
    expect(url).toContain(`brd_json=${BRIGHT_DATA_BRD_JSON}`);
    expect(url).toContain('gl=gb');
    expect(url).toContain('hl=en');
    expect(url).not.toContain('udm=28');
    expect(url).not.toContain('brd_json=1');
  });
});

describe('createBrightDataSerpClient (WARDROBE-98)', () => {
  it('POSTs format=json with Bearer auth and maps shopping JSON onto the Link DTO', async () => {
    const httpPost = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(shoppingJson()),
    });

    const client = createBrightDataSerpClient({
      fetchSecret: async () => SECRET,
      httpPost,
    });

    const links = await client.search({
      keywords: ['black tee'],
      maxLinks: 8,
    });

    expect(links).toEqual([
      {
        title: 'Nike Club Tee',
        url: 'https://www.nike.com/tee',
        merchant: 'Nike',
        price: '£24.99',
        currency: 'GBP',
        imageUrl: 'https://img.example/tee.jpg',
      },
    ]);

    expect(httpPost).toHaveBeenCalledTimes(1);
    const [endpoint, init] = httpPost.mock.calls[0] as [
      string,
      { headers?: Record<string, string>; body?: string },
    ];
    expect(endpoint).toBe(DEFAULT_BRIGHT_DATA_ENDPOINT);
    expect(init.headers?.Authorization).toBe('Bearer brd-token-secret-value');
    expect(init.headers?.['Content-Type']).toBe('application/json');
    expect(init.headers?.Accept).toBe('application/json');

    const posted = JSON.parse(init.body ?? '{}') as {
      zone: string;
      url: string;
      format: string;
      method?: string;
      country: string;
    };
    expect(posted.zone).toBe('serp_api1');
    expect(posted.format).toBe(BRIGHT_DATA_SERP_FORMAT);
    expect(posted.format).toBe('json');
    expect(posted.country).toBe('gb');
    expect(posted.method).toBeUndefined();
    expect(posted.url).toContain('tbm=shop');
    expect(posted.url).toContain('brd_json=json');
    expect(posted.url).not.toContain('udm=28');
  });

  it('throws BrightDataSerpError with status, content-type, and truncated body on HTML', async () => {
    const html = `<!DOCTYPE html><html><body>${'captcha-page '.repeat(80)}</body></html>`;
    const httpPost = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      text: async () => html,
    });

    const client = createBrightDataSerpClient({
      fetchSecret: async () => SECRET,
      httpPost,
    });

    let caught: unknown;
    try {
      await client.search({ keywords: ['black tee'], maxLinks: 8 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BrightDataSerpError);
    const serpError = caught as BrightDataSerpError;
    expect(serpError.message).toBe('Bright Data SERP returned a non-JSON body');
    expect(serpError.status).toBe(200);
    expect(serpError.contentType).toBe('text/html; charset=utf-8');
    expect(serpError.bodySnippet).toBeDefined();
    expect(serpError.bodySnippet?.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(serpError.bodySnippet!.length).toBeLessThanOrEqual(501);
    expect(JSON.stringify(serpError)).not.toContain('brd-token-secret-value');
    expect(serpError.bodySnippet).not.toContain('brd-token-secret-value');
  });

  it('treats Unlocker-style JSON wrapping HTML as a non-JSON SERP body', async () => {
    const httpPost = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
      text: async () =>
        JSON.stringify({
          status_code: 200,
          body: '<!DOCTYPE html><html><head><title>Google</title></head><body>results</body></html>',
        }),
    });

    const client = createBrightDataSerpClient({
      fetchSecret: async () => SECRET,
      httpPost,
    });

    await expect(client.search({ keywords: ['black tee'], maxLinks: 8 })).rejects.toMatchObject({
      name: 'BrightDataSerpError',
      message: 'Bright Data SERP returned a non-JSON body',
      status: 200,
      contentType: 'application/json',
    });
  });

  it('includes HTTP status, content-type, and body snippet on non-2xx', async () => {
    const httpPost = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ error: 'User authentication is required' }),
    });

    const client = createBrightDataSerpClient({
      fetchSecret: async () => SECRET,
      httpPost,
    });

    await expect(client.search({ keywords: ['black tee'], maxLinks: 8 })).rejects.toMatchObject({
      name: 'BrightDataSerpError',
      message: 'Bright Data SERP HTTP 401',
      status: 401,
      contentType: 'application/json',
      bodySnippet: expect.stringContaining('User authentication is required'),
    });
  });
});

describe('upstream log helpers', () => {
  it('redacts Bearer tokens and apiToken JSON fields', () => {
    expect(
      redactSecretMaterial(
        'Authorization: Bearer brd-token-secret-value apiToken":"brd-token-secret-value"',
      ),
    ).toBe('Authorization: Bearer [redacted] apiToken":"[redacted]"');
  });

  it('truncates bodies after collapsing whitespace', () => {
    const snippet = truncateUpstreamBody(`<html>\n${'x'.repeat(600)}\n</html>`);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBe(501);
    expect(snippet.startsWith('<html>')).toBe(true);
  });

  it('reads content-type from Headers-like and plain objects', () => {
    expect(
      headerValue(
        { get: (name: string) => (name === 'content-type' ? 'text/html' : null) },
        'content-type',
      ),
    ).toBe('text/html');
    expect(headerValue({ 'Content-Type': 'application/json' }, 'content-type')).toBe(
      'application/json',
    );
  });
});
