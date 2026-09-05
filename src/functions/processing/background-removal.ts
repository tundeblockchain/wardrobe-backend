import { keys, updateAttributes } from '../../shared/dynamodb';
import { nowIso } from '../../shared/ids';
import { logger } from '../../shared/logger';
import {
  getObjectBytes,
  MAX_UPLOAD_BYTES,
  processedImageObjectKey,
  putObjectBytes,
} from '../../shared/s3';
import { getSecretString, parseJsonObjectOrString } from '../../shared/secrets';
import { DynamoItem } from '../../shared/types';
import { PermanentProcessingError, RetryableProcessingError } from './errors';

export interface BackgroundRemovalContext {
  userId: string;
  wardrobeId: string;
  itemId: string;
  originalImageKey: string;
  item: DynamoItem;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PROCESSED_CONTENT_TYPE = 'image/png';
const PROVIDER_TIMEOUT_MS = 45_000;

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-image';
export const DEFAULT_GEMINI_API_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models';

const BACKGROUND_REMOVAL_PROMPT =
  'Remove the background from this clothing item. Return a PNG image with a fully transparent background. Keep the garment shape, colour, texture, and details unchanged. Do not add, restyle, crop, or replace the clothing.';

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

export interface BackgroundRemovalClient {
  removeBackground(image: Uint8Array, contentType: string): Promise<Uint8Array>;
}

export interface GeminiBackgroundRemovalConfig {
  apiKey: string;
  model: string;
  endpoint: string;
}

export interface ObjectStore {
  getObject(objectKey: string): Promise<{
    bytes: Uint8Array;
    contentType?: string;
  }>;
  putObject(
    objectKey: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void>;
}

export interface ItemMetadataStore {
  update(
    wardrobeId: string,
    itemId: string,
    attributes: Record<string, unknown>,
  ): Promise<void>;
}

export interface BackgroundRemovalDeps {
  store?: ObjectStore;
  metadata?: ItemMetadataStore;
  client?: BackgroundRemovalClient;
  loadConfig?: () => Promise<GeminiBackgroundRemovalConfig>;
  fetchImpl?: typeof fetch;
}

export function geminiGenerateContentUrl(model: string): string {
  return `${DEFAULT_GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`;
}

export function parseBackgroundRemovalSecret(
  secretString: string,
): GeminiBackgroundRemovalConfig {
  const parsed = parseJsonObjectOrString(secretString);
  if (typeof parsed === 'string') {
    return {
      apiKey: parsed,
      model: DEFAULT_GEMINI_MODEL,
      endpoint: geminiGenerateContentUrl(DEFAULT_GEMINI_MODEL),
    };
  }

  const apiKey = firstString(parsed, ['apiKey', 'api_key', 'key']);
  if (!apiKey) {
    throw new RetryableProcessingError(
      'Gemini background-removal secret is missing apiKey.',
    );
  }

  const model =
    firstString(parsed, ['model']) ?? DEFAULT_GEMINI_MODEL;
  const endpoint =
    firstString(parsed, ['endpoint', 'url']) ?? geminiGenerateContentUrl(model);

  return { apiKey, model, endpoint };
}

export async function loadBackgroundRemovalConfig(
  getSecret: (secretId: string) => Promise<string> = getSecretString,
): Promise<GeminiBackgroundRemovalConfig> {
  const secretId = process.env.BACKGROUND_REMOVAL_SECRET_ARN;
  if (!secretId) {
    throw new RetryableProcessingError(
      'BACKGROUND_REMOVAL_SECRET_ARN is not configured.',
    );
  }

  let raw: string;
  try {
    raw = await getSecret(secretId);
  } catch (error) {
    if (error instanceof RetryableProcessingError) {
      throw error;
    }
    throw new RetryableProcessingError(
      error instanceof Error
        ? error.message
        : 'Failed to read Gemini background-removal secret',
      error,
    );
  }

  const fromSecret = parseBackgroundRemovalSecret(raw);
  if (!fromSecret.apiKey) {
    throw new RetryableProcessingError('Gemini API key is empty.');
  }

  const model =
    process.env.GEMINI_MODEL?.trim() || fromSecret.model || DEFAULT_GEMINI_MODEL;
  const endpoint =
    process.env.GEMINI_ENDPOINT?.trim() ||
    fromSecret.endpoint ||
    geminiGenerateContentUrl(model);

  return {
    apiKey: fromSecret.apiKey,
    model,
    endpoint,
  };
}

export function createGeminiBackgroundRemovalClient(
  config: GeminiBackgroundRemovalConfig,
  fetchImpl: typeof fetch = fetch,
): BackgroundRemovalClient {
  return {
    removeBackground(image, contentType) {
      return generateBackgroundRemovedPng(image, contentType, config, fetchImpl);
    },
  };
}

export async function runBackgroundRemoval(
  context: BackgroundRemovalContext,
  deps: BackgroundRemovalDeps = {},
): Promise<string> {
  const originalKey = context.originalImageKey?.trim();
  if (!originalKey) {
    throw new PermanentProcessingError('originalImageKey is missing.');
  }

  const processedKey = processedImageObjectKey(context.userId, context.itemId);
  const store = deps.store ?? defaultObjectStore();
  const metadata = deps.metadata ?? defaultMetadataStore();
  const client = deps.client ?? (await defaultClient(deps));

  const original = await readOriginalImage(store, originalKey);
  const processed = await invokeClient(client, original.bytes, original.contentType);

  try {
    await store.putObject(processedKey, processed, PROCESSED_CONTENT_TYPE);
  } catch (error) {
    throw toRetryable(error, 'Failed to write processed image');
  }

  try {
    await metadata.update(context.wardrobeId, context.itemId, {
      processedKey,
      ai: mergeAiMetadata(context.item, {
        backgroundRemoved: true,
        processedImageKey: processedKey,
      }),
      updatedAt: nowIso(),
    });
  } catch (error) {
    throw toRetryable(error, 'Failed to update processed-image metadata');
  }

  logger.info('Background removed and processed image stored', {
    itemId: context.itemId,
    wardrobeId: context.wardrobeId,
    processedKey,
  });

  return processedKey;
}

function defaultObjectStore(): ObjectStore {
  return {
    async getObject(objectKey) {
      return getObjectBytes(objectKey);
    },
    async putObject(objectKey, bytes, contentType) {
      await putObjectBytes({ objectKey, body: bytes, contentType });
    },
  };
}

function defaultMetadataStore(): ItemMetadataStore {
  return {
    async update(wardrobeId, itemId, attributes) {
      await updateAttributes(
        keys.wardrobePk(wardrobeId),
        keys.itemSk(itemId),
        attributes,
      );
    },
  };
}

async function defaultClient(
  deps: BackgroundRemovalDeps,
): Promise<BackgroundRemovalClient> {
  const loadConfig = deps.loadConfig ?? loadBackgroundRemovalConfig;
  const config = await loadConfig();
  return createGeminiBackgroundRemovalClient(config, deps.fetchImpl ?? fetch);
}

async function readOriginalImage(
  store: ObjectStore,
  objectKey: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  let original: { bytes: Uint8Array; contentType?: string };
  try {
    original = await store.getObject(objectKey);
  } catch (error) {
    throw mapReadError(error, objectKey);
  }

  if (!original.bytes?.length) {
    throw new PermanentProcessingError(`Original image ${objectKey} is empty.`);
  }
  if (original.bytes.length > MAX_UPLOAD_BYTES) {
    throw new PermanentProcessingError(
      `Original image exceeds the ${MAX_UPLOAD_BYTES} byte limit.`,
    );
  }

  return {
    bytes: original.bytes,
    contentType: original.contentType?.trim() || 'application/octet-stream',
  };
}

async function invokeClient(
  client: BackgroundRemovalClient,
  image: Uint8Array,
  contentType: string,
): Promise<Uint8Array> {
  let processed: Uint8Array;
  try {
    processed = await client.removeBackground(image, contentType);
  } catch (error) {
    if (
      error instanceof PermanentProcessingError ||
      error instanceof RetryableProcessingError
    ) {
      throw error;
    }
    throw toRetryable(error, 'Background removal failed');
  }

  if (!isPng(processed)) {
    throw new PermanentProcessingError(
      'Background removal did not return a PNG image.',
    );
  }

  return processed;
}

async function generateBackgroundRemovedPng(
  image: Uint8Array,
  contentType: string,
  config: GeminiBackgroundRemovalConfig,
  fetchImpl: typeof fetch,
): Promise<Uint8Array> {
  const mimeType = resolveImageMimeType(image, contentType);
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: BACKGROUND_REMOVAL_PROMPT },
          {
            inlineData: {
              mimeType,
              data: Buffer.from(image).toString('base64'),
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  };

  let response: Response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    throw toRetryable(error, 'Gemini background-removal request failed');
  }

  if (!response.ok) {
    throw classifyProviderStatus(response.status);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new PermanentProcessingError(
      'Gemini background removal returned a non-JSON body.',
    );
  }

  const blocked = geminiBlockReason(payload);
  if (blocked) {
    throw new PermanentProcessingError(
      `Gemini blocked the clothing image (${blocked})`,
    );
  }

  const processed = extractGeminiInlineImage(payload);
  if (!processed?.length) {
    throw new PermanentProcessingError(
      'Gemini did not return an image for background removal.',
    );
  }

  return processed;
}

function classifyProviderStatus(status: number): never {
  if (status === 429 || status === 401 || status === 403 || status >= 500) {
    throw new RetryableProcessingError(
      `Gemini background removal returned ${status}`,
    );
  }
  throw new PermanentProcessingError(
    `Gemini rejected the image (${status})`,
  );
}

function extractGeminiInlineImage(payload: unknown): Uint8Array | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) {
    return undefined;
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const content = (candidate as { content?: { parts?: unknown } }).content;
    const parts = content?.parts;
    if (!Array.isArray(parts)) {
      continue;
    }
    for (const part of parts) {
      const bytes = decodeInlineImage(part);
      if (bytes) {
        return bytes;
      }
    }
  }

  return undefined;
}

function decodeInlineImage(part: unknown): Uint8Array | undefined {
  if (!part || typeof part !== 'object') {
    return undefined;
  }
  const record = part as Record<string, unknown>;
  const inline =
    asRecord(record.inlineData) ?? asRecord(record.inline_data);
  const data = firstString(inline ?? {}, ['data']);
  if (!data) {
    return undefined;
  }

  const bytes = Buffer.from(data, 'base64');
  return bytes.length ? new Uint8Array(bytes) : undefined;
}

function geminiBlockReason(payload: unknown): string | undefined {
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

function resolveImageMimeType(image: Uint8Array, contentType: string): string {
  const normalized = contentType.trim().toLowerCase();
  if (normalized === 'image/jpg') {
    return 'image/jpeg';
  }
  if (IMAGE_MIME_TYPES.has(normalized)) {
    return normalized;
  }
  return inferImageMimeType(image);
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

function mapReadError(error: unknown, objectKey: string): never {
  if (
    error instanceof PermanentProcessingError ||
    error instanceof RetryableProcessingError
  ) {
    throw error;
  }

  const name = error instanceof Error ? error.name : '';
  if (name === 'NoSuchKey' || name === 'NotFound') {
    throw new PermanentProcessingError(`Original image not found: ${objectKey}`);
  }

  throw toRetryable(error, 'Failed to read original image');
}

function mergeAiMetadata(
  item: DynamoItem,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const existing = item.ai;
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  return { ...base, ...patch };
}

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC.length) {
    return false;
  }
  return PNG_MAGIC.equals(Buffer.from(bytes.subarray(0, PNG_MAGIC.length)));
}

function firstString(
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function toRetryable(error: unknown, fallback: string): RetryableProcessingError {
  if (error instanceof RetryableProcessingError) {
    return error;
  }
  return new RetryableProcessingError(
    error instanceof Error ? error.message : fallback,
    error,
  );
}
