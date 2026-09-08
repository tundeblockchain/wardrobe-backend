import { PermanentProcessingError, RetryableProcessingError } from '../../src/functions/processing/errors';
import {
  DEFAULT_GEMINI_CLASSIFIER_MODEL,
  classifyGeminiHttpStatus,
  extractGeminiText,
  geminiBlockReason,
  geminiGenerateContentUrl,
  geminiRequestPath,
  normalizeGeminiModelId,
  parseGeminiApiSecret,
  parseGeminiJsonText,
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

  it('remaps retired Gemini model ids to the caller fallback', () => {
    expect(normalizeGeminiModelId('gemini-2.0-flash', DEFAULT_GEMINI_CLASSIFIER_MODEL)).toBe(
      DEFAULT_GEMINI_CLASSIFIER_MODEL,
    );
    expect(normalizeGeminiModelId('gemini-1.5-flash', DEFAULT_GEMINI_CLASSIFIER_MODEL)).toBe(
      DEFAULT_GEMINI_CLASSIFIER_MODEL,
    );
    expect(normalizeGeminiModelId('gemini-pro-vision', DEFAULT_GEMINI_CLASSIFIER_MODEL)).toBe(
      DEFAULT_GEMINI_CLASSIFIER_MODEL,
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
});
