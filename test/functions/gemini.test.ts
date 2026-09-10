import { PermanentProcessingError, RetryableProcessingError } from '../../src/functions/processing/errors';
import {
  DEFAULT_GEMINI_CLASSIFIER_MODEL,
  DEFAULT_GEMINI_CLASSIFY_COLOUR_MODEL,
  DEFAULT_GEMINI_COLOUR_MODEL,
  GEMINI_GOOGLE_API_VERSION,
  INTERIOR_GEMINI_REQUEST_HEADERS,
  classifyGeminiHttpStatus,
  detectGeminiImageMimeType,
  extractGeminiInlineImage,
  extractGeminiText,
  fetchGeminiGenerateContent,
  geminiBlockReason,
  geminiGenerateContentRequestUrl,
  geminiGenerateContentUrl,
  geminiRequestPath,
  normalizeGeminiModelId,
  parseGeminiApiSecret,
  parseGeminiJsonText,
  pinClassifyColourGeminiConfig,
  resolveGeminiEndpoint,
  resolveGeminiGenerateContentConfig,
} from '../../src/functions/processing/gemini';

describe('Gemini generateContent helpers', () => {
  it('builds a generateContent URL', () => {
    expect(geminiGenerateContentUrl('gemini-2.5-flash')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
  });

  it('strips a models/ prefix so the generateContent path does not 404', () => {
    expect(geminiGenerateContentUrl('models/gemini-2.5-flash')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
    expect(normalizeGeminiModelId('models/gemini-2.5-flash', 'fallback')).toBe(
      'gemini-2.5-flash',
    );
  });

  it('remaps retired Gemini model ids to the caller fallback, not gemini-2.5-flash', () => {
    expect(normalizeGeminiModelId('gemini-2.0-flash', DEFAULT_GEMINI_CLASSIFIER_MODEL)).toBe(
      DEFAULT_GEMINI_CLASSIFY_COLOUR_MODEL,
    );
    expect(normalizeGeminiModelId('gemini-1.5-flash', DEFAULT_GEMINI_CLASSIFIER_MODEL)).toBe(
      DEFAULT_GEMINI_CLASSIFY_COLOUR_MODEL,
    );
    expect(normalizeGeminiModelId('gemini-pro-vision', DEFAULT_GEMINI_CLASSIFIER_MODEL)).toBe(
      DEFAULT_GEMINI_CLASSIFY_COLOUR_MODEL,
    );
    expect(normalizeGeminiModelId('gemini-2.0-flash', DEFAULT_GEMINI_CLASSIFIER_MODEL)).not.toBe(
      'gemini-2.5-flash',
    );
  });

  it('hardcodes classify/colour to gemini-3.1-flash-lite and does not remap onto gemini-2.5-flash', () => {
    expect(DEFAULT_GEMINI_CLASSIFIER_MODEL).toBe('gemini-3.1-flash-lite');
    expect(DEFAULT_GEMINI_COLOUR_MODEL).toBe('gemini-3.1-flash-lite');
    expect(DEFAULT_GEMINI_CLASSIFY_COLOUR_MODEL).toBe('gemini-3.1-flash-lite');
    expect(DEFAULT_GEMINI_CLASSIFIER_MODEL).not.toBe('gemini-2.5-flash');
    expect(DEFAULT_GEMINI_COLOUR_MODEL).not.toBe('gemini-2.5-flash');

    const pinned = pinClassifyColourGeminiConfig({
      apiKey: 'key',
      model: 'gemini-2.5-flash',
      endpoint: geminiGenerateContentUrl('gemini-2.5-flash'),
    });
    expect(pinned).toEqual({
      apiKey: 'key',
      model: 'gemini-3.1-flash-lite',
      endpoint: geminiGenerateContentUrl('gemini-3.1-flash-lite'),
    });
    expect(pinned.model).not.toBe('gemini-2.5-flash');
    expect(pinned.endpoint).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
    );
    expect(geminiRequestPath(pinned.endpoint)).toBe(
      '/v1beta/models/gemini-3.1-flash-lite:generateContent',
    );
  });

  it('rebuilds Google slash-method and v1 endpoints onto v1beta :generateContent', () => {
    expect(
      resolveGeminiEndpoint(
        'gemini-2.5-flash',
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash/generateContent',
      ),
    ).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
    expect(
      resolveGeminiEndpoint(
        'gemini-2.5-flash',
        'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent',
      ),
    ).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
  });

  it('keeps a non-Google proxy endpoint and redacts key query params from the path', () => {
    expect(
      resolveGeminiEndpoint(
        'gemini-2.5-flash',
        'https://proxy.example/v1/generateContent?key=super-secret',
      ),
    ).toBe('https://proxy.example/v1/generateContent');
    expect(
      geminiRequestPath(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=super-secret',
      ),
    ).toBe('/v1beta/models/gemini-2.5-flash:generateContent');
  });

  it('rebuilds the Google URL when env overrides only the model', () => {
    expect(
      resolveGeminiGenerateContentConfig(
        {
          apiKey: 'key',
          model: 'gemini-2.0-flash',
          endpoint:
            'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent',
        },
        {
          defaultModel: DEFAULT_GEMINI_CLASSIFIER_MODEL,
          modelOverride: 'gemini-2.5-flash',
        },
      ),
    ).toEqual({
      apiKey: 'key',
      model: 'gemini-2.5-flash',
      endpoint: geminiGenerateContentUrl('gemini-2.5-flash'),
    });
  });

  it('extracts concatenated text parts and parses fenced JSON', () => {
    expect(
      extractGeminiText({
        candidates: [
          {
            content: {
              parts: [{ text: '{"detectedCategory":"TOP"}' }],
            },
          },
        ],
      }),
    ).toBe('{"detectedCategory":"TOP"}');

    expect(parseGeminiJsonText('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseGeminiJsonText('{"b":2}')).toEqual({ b: 2 });
  });

  it('sniffs PNG and JPEG magic and prefers the last inline image', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x01]);
    expect(detectGeminiImageMimeType(png)).toBe('image/png');
    expect(detectGeminiImageMimeType(jpeg)).toBe('image/jpeg');
    expect(detectGeminiImageMimeType(Uint8Array.from([0x00, 0x01]))).toBeUndefined();

    expect(
      extractGeminiInlineImage({
        candidates: [
          {
            content: {
              parts: [
                { inlineData: { mimeType: 'image/png', data: Buffer.from(png).toString('base64') } },
                { inlineData: { mimeType: 'image/jpeg', data: Buffer.from(jpeg).toString('base64') } },
              ],
            },
          },
        ],
      }),
    ).toEqual(jpeg);
  });

  it('detects prompt and finish-reason safety blocks', () => {
    expect(
      geminiBlockReason({ promptFeedback: { blockReason: 'SAFETY' } }),
    ).toBe('SAFETY');
    expect(
      geminiBlockReason({
        candidates: [{ finishReason: 'IMAGE_SAFETY' }],
      }),
    ).toBe('IMAGE_SAFETY');
    expect(
      geminiBlockReason({
        candidates: [{ finishReason: 'STOP' }],
      }),
    ).toBeUndefined();
  });

  it('maps Gemini HTTP statuses to retryable vs permanent', () => {
    expect(() => classifyGeminiHttpStatus(429, 'Gemini classifier')).toThrow(
      RetryableProcessingError,
    );
    expect(() => classifyGeminiHttpStatus(503, 'Gemini classifier')).toThrow(
      RetryableProcessingError,
    );
    expect(() => classifyGeminiHttpStatus(401, 'Gemini classifier')).toThrow(
      RetryableProcessingError,
    );
    expect(() => classifyGeminiHttpStatus(422, 'Gemini classifier')).toThrow(
      PermanentProcessingError,
    );
    expect(() => classifyGeminiHttpStatus(404, 'Gemini classifier')).toThrow(
      PermanentProcessingError,
    );
    expect(() => classifyGeminiHttpStatus(404, 'Gemini classifier')).toThrow(
      /Gemini classifier rejected the request \(404\)/,
    );
  });

  it('parses a plain key against the default classifier model', () => {
    expect(parseGeminiApiSecret('key', DEFAULT_GEMINI_CLASSIFIER_MODEL)).toEqual({
      apiKey: 'key',
      model: DEFAULT_GEMINI_CLASSIFIER_MODEL,
      endpoint: geminiGenerateContentUrl(DEFAULT_GEMINI_CLASSIFIER_MODEL),
    });
  });

  it('adopts Interior-design-backend generateContent request shape for classify', async () => {
    expect(GEMINI_GOOGLE_API_VERSION).toBe('v1beta');
    expect(DEFAULT_GEMINI_CLASSIFIER_MODEL).toBe('gemini-3.1-flash-lite');
    expect(DEFAULT_GEMINI_CLASSIFIER_MODEL).not.toBe('gemini-2.5-flash');
    expect(INTERIOR_GEMINI_REQUEST_HEADERS).toEqual({
      'content-type': 'application/json',
    });

    const config = pinClassifyColourGeminiConfig({
      apiKey: 'interior-key',
      model: 'gemini-2.5-flash',
      endpoint: geminiGenerateContentUrl('gemini-2.5-flash'),
    });
    expect(config.model).toBe('gemini-3.1-flash-lite');
    expect(config.model).not.toBe('gemini-2.5-flash');
    expect(geminiRequestPath(config.endpoint)).toBe(
      '/v1beta/models/gemini-3.1-flash-lite:generateContent',
    );
    expect(config.endpoint).toContain(`/${GEMINI_GOOGLE_API_VERSION}/`);
    expect(config.endpoint).toContain(':generateContent');
    expect(config.endpoint).not.toContain('interior-key');

    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{}',
    });

    await fetchGeminiGenerateContent(
      config,
      { contents: [] },
      fetchImpl as unknown as typeof fetch,
      {
        stage: 'classify',
        label: 'Gemini classifier',
        networkErrorMessage: 'failed',
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    expect(url).toBe(
      geminiGenerateContentRequestUrl(config.endpoint, 'interior-key'),
    );
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=interior-key',
    );
    expect(url).toContain('?key=interior-key');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(init.headers).not.toHaveProperty('x-goog-api-key');
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(init.headers).not.toHaveProperty('authorization');
  });
});
