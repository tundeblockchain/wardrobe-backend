import { logger } from '../../shared/logger';
import { PermanentProcessingError, RetryableProcessingError } from './errors';

export const GEMINI_GOOGLE_API_HOST = 'generativelanguage.googleapis.com';

/** API version Interior-design-backend GeminiRenderer uses (working prod call). */
export const GEMINI_GOOGLE_API_VERSION = 'v1beta';

export const DEFAULT_GEMINI_API_BASE =
  `https://${GEMINI_GOOGLE_API_HOST}/${GEMINI_GOOGLE_API_VERSION}/models`;

/**
 * Interior-design-backend `gemini-renderer.ts` request headers.
 * Auth is the `key` query param — not `x-goog-api-key` or Authorization.
 */
export const INTERIOR_GEMINI_REQUEST_HEADERS = {
  'content-type': 'application/json',
} as const;

/** Item-processing pipeline stages that call Gemini (WARDROBE-64 logs). */
export type GeminiPipelineStage =
  | 'bg-removal'
  | 'classify'
  | 'colour'
  | 'try-on'
  | 'other';

export type GeminiPipelineEvent = 'start' | 'success' | 'fail' | 'skip';

/** Image-edit model used by WARDROBE-26 background removal. */
export const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';

/** Image-generation model used by WARDROBE-47 virtual try-on. */
export const DEFAULT_GEMINI_TRY_ON_MODEL = DEFAULT_GEMINI_IMAGE_MODEL;

/**
 * WARDROBE-65: classify and colour are hardcoded to flash-lite.
 * `gemini-2.5-flash` 404s in prod (`/v1beta/models/gemini-2.5-flash:generateContent`)
 * and must not be the default or remap target for those stages.
 */
export const DEFAULT_GEMINI_CLASSIFY_COLOUR_MODEL = 'gemini-2.5-flash-lite';

/** Multimodal text model used by WARDROBE-27 garment classification. */
export const DEFAULT_GEMINI_CLASSIFIER_MODEL = DEFAULT_GEMINI_CLASSIFY_COLOUR_MODEL;

/** Multimodal text model used by WARDROBE-29 colour / category detection. */
export const DEFAULT_GEMINI_COLOUR_MODEL = DEFAULT_GEMINI_CLASSIFY_COLOUR_MODEL;

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

/**
 * Build the Google AI generateContent URL.
 * Strips a leading `models/` prefix — that resource name is already in the
 * path, and leaving it in the model id 404s (`/v1beta/models/models/...`).
 */
export function geminiGenerateContentUrl(model: string): string {
  const id = stripGeminiModelDecorators(model);
  return `${DEFAULT_GEMINI_API_BASE}/${encodeURIComponent(id)}:generateContent`;
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

  const model = normalizeGeminiModelId(
    firstString(parsed, ['model']),
    defaultModel,
  );
  const endpoint = resolveGeminiEndpoint(
    model,
    firstString(parsed, ['endpoint', 'url']),
  );

  return { apiKey, model, endpoint };
}

/**
 * Retired Gemini ids that 404 on generateContent (WARDROBE-64).
 * 1.0 / 1.5 / 2.0 Flash families and the old `gemini-pro` aliases.
 */
const RETIRED_GEMINI_MODEL_IDS = new Set([
  'gemini-pro',
  'gemini-pro-vision',
  'gemini-1.0-pro',
  'gemini-1.0-pro-001',
  'gemini-1.0-pro-latest',
  'gemini-1.0-pro-vision',
  'gemini-1.0-pro-vision-latest',
  'gemini-1.5-flash',
  'gemini-1.5-flash-001',
  'gemini-1.5-flash-002',
  'gemini-1.5-flash-latest',
  'gemini-1.5-flash-8b',
  'gemini-1.5-flash-8b-001',
  'gemini-1.5-flash-8b-latest',
  'gemini-1.5-pro',
  'gemini-1.5-pro-001',
  'gemini-1.5-pro-002',
  'gemini-1.5-pro-latest',
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-exp',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash-lite-001',
]);

export function isRetiredGeminiModel(model: string): boolean {
  return RETIRED_GEMINI_MODEL_IDS.has(model.trim().toLowerCase());
}

/**
 * Strip `models/` and `:generateContent` / `/generateContent` decorations.
 * Google's resource name is `models/{id}`; the URL already has `/models/`.
 */
export function stripGeminiModelDecorators(model: string): string {
  let id = model.trim();
  if (/^https?:\/\//i.test(id)) {
    id = extractGeminiModelFromUrl(id) ?? id;
  }
  id = id.replace(/^models\//i, '');
  id = id.replace(/:generateContent$/i, '');
  id = id.replace(/\/generateContent$/i, '');
  id = id.replace(/^models\//i, '');
  return id || model.trim();
}

export function normalizeGeminiModelId(
  raw: string | undefined,
  fallback: string,
): string {
  if (!raw?.trim()) {
    return fallback;
  }
  const id = stripGeminiModelDecorators(raw);
  if (!id || isRetiredGeminiModel(id)) {
    return fallback;
  }
  return id;
}

export function isCustomGeminiProxy(endpoint: string | undefined): boolean {
  if (!endpoint?.trim()) {
    return false;
  }
  try {
    return new URL(endpoint.trim()).hostname !== GEMINI_GOOGLE_API_HOST;
  } catch {
    return true;
  }
}

/**
 * Use a custom (non-Google) proxy as-is; rebuild Google generateContent
 * URLs from the resolved model so slash-method / `models/` / v1 / retired
 * paths cannot 404.
 */
export function resolveGeminiEndpoint(
  model: string,
  explicitEndpoint?: string,
): string {
  const trimmed = explicitEndpoint?.trim();
  if (trimmed && isCustomGeminiProxy(trimmed)) {
    return stripSecretQueryParams(trimmed);
  }
  return geminiGenerateContentUrl(model);
}

export function resolveGeminiGenerateContentConfig(
  fromSecret: GeminiGenerateContentConfig,
  options: {
    defaultModel: string;
    modelOverride?: string;
    endpointOverride?: string;
  },
): GeminiGenerateContentConfig {
  const model = normalizeGeminiModelId(
    options.modelOverride || fromSecret.model,
    options.defaultModel,
  );
  const modelOverridden = Boolean(options.modelOverride?.trim());
  const explicitEndpoint =
    options.endpointOverride?.trim() ||
    (modelOverridden && !isCustomGeminiProxy(fromSecret.endpoint)
      ? undefined
      : fromSecret.endpoint);
  return {
    apiKey: fromSecret.apiKey,
    model,
    endpoint: resolveGeminiEndpoint(model, explicitEndpoint),
  };
}

/**
 * WARDROBE-65: pin classify / colour onto the hardcoded flash-lite model
 * and rebuild the Google generateContent URL. Secret stays API key only —
 * any secret/env model (including gemini-2.5-flash) is ignored.
 */
export function pinClassifyColourGeminiConfig(
  fromSecret: GeminiGenerateContentConfig,
  endpointOverride?: string,
): GeminiGenerateContentConfig {
  return resolveGeminiGenerateContentConfig(fromSecret, {
    defaultModel: DEFAULT_GEMINI_CLASSIFY_COLOUR_MODEL,
    modelOverride: DEFAULT_GEMINI_CLASSIFY_COLOUR_MODEL,
    endpointOverride,
  });
}

/** Pathname only — never include `?key=` or other query secrets. */
export function geminiRequestPath(endpoint: string): string {
  try {
    return new URL(endpoint).pathname;
  } catch {
    const withoutQuery = endpoint.split('?')[0] ?? endpoint;
    return withoutQuery;
  }
}

/**
 * Interior-design-backend GeminiRenderer auth: `?key=` on the generateContent URL.
 * Used only at fetch time so logs / stored endpoints never keep the API key.
 */
export function geminiGenerateContentRequestUrl(
  endpoint: string,
  apiKey: string,
): string {
  try {
    const url = new URL(endpoint);
    url.searchParams.set('key', apiKey);
    return url.toString();
  } catch {
    const [base, query = ''] = endpoint.split('?');
    const params = new URLSearchParams(query);
    params.set('key', apiKey);
    const serialized = params.toString();
    return serialized ? `${base}?${serialized}` : `${base}?key=${encodeURIComponent(apiKey)}`;
  }
}

export function logGeminiPipelineStage(
  event: GeminiPipelineEvent,
  fields: {
    stage: GeminiPipelineStage;
    itemId?: string;
    wardrobeId?: string;
    geminiHttpStatus?: number;
    geminiModel?: string;
    geminiRequestPath?: string;
    error?: string;
    reason?: string;
  },
): void {
  const message =
    event === 'start'
      ? 'Gemini pipeline stage start'
      : event === 'success'
        ? 'Gemini pipeline stage success'
        : event === 'skip'
          ? 'Gemini pipeline stage skip'
          : 'Gemini pipeline stage fail';
  const write = event === 'fail' ? logger.error : logger.info;
  write(message, {
    stage: fields.stage,
    pipelineEvent: event,
    ...(fields.itemId ? { itemId: fields.itemId } : {}),
    ...(fields.wardrobeId ? { wardrobeId: fields.wardrobeId } : {}),
    ...(fields.geminiHttpStatus !== undefined
      ? { geminiHttpStatus: fields.geminiHttpStatus }
      : {}),
    ...(fields.geminiModel ? { geminiModel: fields.geminiModel } : {}),
    ...(fields.geminiRequestPath
      ? { geminiRequestPath: fields.geminiRequestPath }
      : {}),
    ...(fields.error ? { error: fields.error } : {}),
    ...(fields.reason ? { reason: fields.reason } : {}),
  });
}

/**
 * POST generateContent using Interior-design-backend's working request shape:
 * `v1beta` `:generateContent` URL + `?key=` query + `content-type` only.
 * Classify/colour stay on hardcoded flash-lite (not gemini-2.5-flash).
 */
export async function fetchGeminiGenerateContent(
  config: GeminiGenerateContentConfig,
  body: unknown,
  fetchImpl: typeof fetch,
  options: {
    stage: GeminiPipelineStage;
    label: string;
    itemId?: string;
    wardrobeId?: string;
    networkErrorMessage: string;
  },
): Promise<Response> {
  const requestPath = geminiRequestPath(config.endpoint);
  logGeminiPipelineStage('start', {
    stage: options.stage,
    itemId: options.itemId,
    wardrobeId: options.wardrobeId,
    geminiModel: config.model,
    geminiRequestPath: requestPath,
  });

  let response: Response;
  try {
    response = await fetchImpl(
      geminiGenerateContentRequestUrl(config.endpoint, config.apiKey),
      {
        method: 'POST',
        headers: { ...INTERIOR_GEMINI_REQUEST_HEADERS },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GEMINI_PROVIDER_TIMEOUT_MS),
      },
    );
  } catch (error) {
    if (
      error instanceof PermanentProcessingError ||
      error instanceof RetryableProcessingError
    ) {
      throw error;
    }
    logGeminiPipelineStage('fail', {
      stage: options.stage,
      itemId: options.itemId,
      wardrobeId: options.wardrobeId,
      geminiModel: config.model,
      geminiRequestPath: requestPath,
      error: error instanceof Error ? error.message : options.networkErrorMessage,
    });
    throw new RetryableProcessingError(
      error instanceof Error ? error.message : options.networkErrorMessage,
      error,
    );
  }

  if (!response.ok) {
    logGeminiPipelineStage('fail', {
      stage: options.stage,
      itemId: options.itemId,
      wardrobeId: options.wardrobeId,
      geminiHttpStatus: response.status,
      geminiModel: config.model,
      geminiRequestPath: requestPath,
    });
    classifyGeminiHttpStatus(response.status, options.label);
  }

  logGeminiPipelineStage('success', {
    stage: options.stage,
    itemId: options.itemId,
    wardrobeId: options.wardrobeId,
    geminiHttpStatus: response.status,
    geminiModel: config.model,
    geminiRequestPath: requestPath,
  });
  return response;
}

function extractGeminiModelFromUrl(endpoint: string): string | undefined {
  try {
    const pathname = new URL(endpoint).pathname;
    const match = pathname.match(
      /\/models\/(.+?)(?::generateContent|\/generateContent)?\/?$/i,
    );
    if (!match?.[1]) {
      return undefined;
    }
    return decodeURIComponent(match[1]).replace(/^models\//i, '');
  } catch {
    return undefined;
  }
}

function stripSecretQueryParams(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.searchParams.delete('key');
    url.searchParams.delete('apiKey');
    url.searchParams.delete('api_key');
    return url.toString();
  } catch {
    return endpoint.split('?')[0] ?? endpoint;
  }
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
