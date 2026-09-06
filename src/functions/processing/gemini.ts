import { PermanentProcessingError, RetryableProcessingError } from './errors';

export const DEFAULT_GEMINI_API_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models';

/** Image-edit model used by WARDROBE-26 background removal. */
export const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';

/** Image-generation model used by WARDROBE-47 virtual try-on. */
export const DEFAULT_GEMINI_TRY_ON_MODEL = DEFAULT_GEMINI_IMAGE_MODEL;

/** Multimodal text model used by WARDROBE-27 garment classification. */
export const DEFAULT_GEMINI_CLASSIFIER_MODEL = 'gemini-2.5-flash';

/** Multimodal text model used by WARDROBE-29 colour / category detection. */
export const DEFAULT_GEMINI_COLOUR_MODEL = 'gemini-2.5-flash';

export const GEMINI_PROVIDER_TIMEOUT_MS = 45_000;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
]);

const BLOCKED_FINISH_REASONS = new Set([
  'SAFETY',
  'IMAGE_SAFETY',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'RECITATION',
]);

export interface GeminiGenerateContentConfig {
  apiKey: string;
  model: string;
  endpoint: string;
}

export function geminiGenerateContentUrl(model: string): string {
  return `${DEFAULT_GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`;
}

/**
 * Plain API key, or JSON `{ apiKey, model?, endpoint? }`.
 * Missing apiKey is retryable so an unpopulated Secrets Manager
 * placeholder does not permanently fail the worker.
 */
export function parseGeminiApiSecret(
  secretString: string,
  defaultModel: string,
): GeminiGenerateContentConfig {
  const trimmed = secretString.trim();
  if (!trimmed) {
    throw new RetryableProcessingError('Gemini secret is empty.');
  }

  if (!trimmed.startsWith('{')) {
    return {
      apiKey: trimmed,
      model: defaultModel,
      endpoint: geminiGenerateContentUrl(defaultModel),
    };
  }

  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new PermanentProcessingError('Gemini secret JSON must be an object.');
    }
    parsed = value as Record<string, unknown>;
  } catch (error) {
    if (
      error instanceof PermanentProcessingError ||
      error instanceof RetryableProcessingError
    ) {
      throw error;
    }
    throw new PermanentProcessingError('Gemini secret is not valid JSON.');
  }

  const apiKey = firstString(parsed, ['apiKey', 'api_key', 'key']);
  if (!apiKey) {
    throw new RetryableProcessingError('Gemini secret is missing apiKey.');
  }

  const model = firstString(parsed, ['model']) ?? defaultModel;
  const endpoint =
    firstString(parsed, ['endpoint', 'url']) ?? geminiGenerateContentUrl(model);

  return { apiKey, model, endpoint };
}

export function resolveGeminiImageMimeType(
  image: Uint8Array,
  contentType: string,
): string {
  const normalized = contentType.trim().toLowerCase();
  if (normalized === 'image/jpg') {
    return 'image/jpeg';
  }
  if (IMAGE_MIME_TYPES.has(normalized)) {
    return normalized;
  }
  return inferImageMimeType(image);
}

export function geminiBlockReason(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const promptFeedback = asRecord(
    (payload as { promptFeedback?: unknown; prompt_feedback?: unknown })
      .promptFeedback ??
      (payload as { prompt_feedback?: unknown }).prompt_feedback,
  );
  const promptBlock = firstString(promptFeedback ?? {}, [
    'blockReason',
    'block_reason',
  ]);
  if (promptBlock) {
    return promptBlock;
  }

  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || !candidates[0] || typeof candidates[0] !== 'object') {
    return undefined;
  }

  const finishReason = firstString(candidates[0] as Record<string, unknown>, [
    'finishReason',
    'finish_reason',
  ]);
  if (finishReason && BLOCKED_FINISH_REASONS.has(finishReason.toUpperCase())) {
    return finishReason;
  }

  return undefined;
}

export function extractGeminiInlineImage(payload: unknown): Uint8Array | undefined {
  for (const part of geminiParts(payload)) {
    const bytes = decodeInlineImage(part);
    if (bytes) {
      return bytes;
    }
  }
  return undefined;
}

export function extractGeminiText(payload: unknown): string | undefined {
  const chunks: string[] = [];
  for (const part of geminiParts(payload)) {
    const text = firstString(asRecord(part) ?? {}, ['text']);
    if (text) {
      chunks.push(text);
    }
  }
  const joined = chunks.join('\n').trim();
  return joined || undefined;
}

export function parseGeminiJsonText(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const raw = (fenced ? fenced[1] : trimmed).trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    throw new PermanentProcessingError('Gemini returned a non-JSON body');
  }
}

export function classifyGeminiHttpStatus(status: number, label: string): never {
  if (status === 429 || status === 401 || status === 403 || status >= 500) {
    throw new RetryableProcessingError(`${label} returned ${status}`);
  }
  throw new PermanentProcessingError(`${label} rejected the request (${status})`);
}

export function firstString(
  record: Record<string, unknown>,
  keysToTry: string[],
): string | undefined {
  for (const key of keysToTry) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function geminiParts(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) {
    return [];
  }

  const parts: unknown[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const content = (candidate as { content?: { parts?: unknown } }).content;
    if (Array.isArray(content?.parts)) {
      parts.push(...content.parts);
    }
  }
  return parts;
}

function decodeInlineImage(part: unknown): Uint8Array | undefined {
  if (!part || typeof part !== 'object') {
    return undefined;
  }
  const record = part as Record<string, unknown>;
  const inline = asRecord(record.inlineData) ?? asRecord(record.inline_data);
  const data = firstString(inline ?? {}, ['data']);
  if (!data) {
    return undefined;
  }

  const bytes = Buffer.from(data, 'base64');
  return bytes.length ? new Uint8Array(bytes) : undefined;
}

function inferImageMimeType(bytes: Uint8Array): string {
  if (bytes.length >= 8 && PNG_MAGIC.equals(Buffer.from(bytes.subarray(0, 8)))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return 'image/jpeg';
}
