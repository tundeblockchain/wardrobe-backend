import { keys, updateAttributes } from '../../shared/dynamodb';
import { nowIso } from '../../shared/ids';
import { logger } from '../../shared/logger';
import {
  getObjectBytes,
  MAX_UPLOAD_BYTES,
  processedImageObjectKey,
  putObjectBytes,
} from '../../shared/s3';
import { getSecretString } from '../../shared/secrets';
import { DynamoItem } from '../../shared/types';
import { PermanentProcessingError, RetryableProcessingError } from './errors';
import {
  DEFAULT_GEMINI_API_BASE,
  DEFAULT_GEMINI_IMAGE_MODEL,
  GEMINI_PROVIDER_TIMEOUT_MS,
  classifyGeminiHttpStatus,
  extractGeminiInlineImage,
  geminiBlockReason,
  geminiGenerateContentUrl,
  parseGeminiApiSecret,
  resolveGeminiImageMimeType,
} from './gemini';

export interface BackgroundRemovalContext {
  userId: string;
  wardrobeId: string;
  itemId: string;
  originalImageKey: string;
  item: DynamoItem;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PROCESSED_CONTENT_TYPE = 'image/png';

export const DEFAULT_GEMINI_MODEL = DEFAULT_GEMINI_IMAGE_MODEL;
export { DEFAULT_GEMINI_API_BASE, geminiGenerateContentUrl };

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

export function parseBackgroundRemovalSecret(
  secretString: string,
): GeminiBackgroundRemovalConfig {
  return parseGeminiApiSecret(secretString, DEFAULT_GEMINI_MODEL);
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
  const mimeType = resolveGeminiImageMimeType(image, contentType);
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
      signal: AbortSignal.timeout(GEMINI_PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    throw toRetryable(error, 'Gemini background-removal request failed');
  }

  if (!response.ok) {
    classifyGeminiHttpStatus(response.status, 'Gemini background removal');
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

function toRetryable(error: unknown, fallback: string): RetryableProcessingError {
  if (error instanceof RetryableProcessingError) {
    return error;
  }
  return new RetryableProcessingError(
    error instanceof Error ? error.message : fallback,
    error,
  );
}
