import { PermanentProcessingError, RetryableProcessingError } from '../../src/functions/processing/errors';
import {
  DEFAULT_GEMINI_CLASSIFIER_MODEL,
  classifyGeminiHttpStatus,
  extractGeminiText,
  geminiBlockReason,
  geminiGenerateContentUrl,
  parseGeminiApiSecret,
  parseGeminiJsonText,
} from '../../src/functions/processing/gemini';

describe('Gemini generateContent helpers', () => {
  it('builds a generateContent URL', () => {
    expect(geminiGenerateContentUrl('gemini-2.5-flash')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
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
  });

  it('parses a plain key against the default classifier model', () => {
    expect(parseGeminiApiSecret('key', DEFAULT_GEMINI_CLASSIFIER_MODEL)).toEqual({
      apiKey: 'key',
      model: DEFAULT_GEMINI_CLASSIFIER_MODEL,
      endpoint: geminiGenerateContentUrl(DEFAULT_GEMINI_CLASSIFIER_MODEL),
    });
  });
});
