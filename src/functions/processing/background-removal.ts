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
const DEFAULT_FIELD_NAME = 'image_file';
const PROVIDER_TIMEOUT_MS = 45_000;

export interface BackgroundRemovalClient {
  removeBackground(image: Uint8Array, contentType: string): Promise<Uint8Array>;
}

export interface HttpBackgroundRemovalConfig {
  apiKey: string;
  endpoint: string;
  fieldName?: string;
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
  loadConfig?: () => Promise<HttpBackgroundRemovalConfig>;
  fetchImpl?: typeof fetch;
}

export function parseBackgroundRemovalSecret(
  secretString: string,
): HttpBackgroundRemovalConfig {
  const parsed = parseJsonObjectOrString(secretString);
  if (typeof parsed === 'string') {
    return { apiKey: parsed, endpoint: '' };
  }

  const apiKey = firstString(parsed, ['apiKey', 'api_key', 'key']);
  if (!apiKey) {
    throw new RetryableProcessingError(
      'Background removal secret is missing apiKey.',
    );
  }

  return {
    apiKey,
    endpoint: firstString(parsed, ['endpoint', 'url']) ?? '',
    fieldName: firstString(parsed, ['fieldName', 'field_name']),
  };
}

export async function loadBackgroundRemovalConfig(
  getSecret: (secretId: string) => Promise<string> = getSecretString,
): Promise<HttpBackgroundRemovalConfig> {
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
        : 'Failed to read background-removal secret',
      error,
    );
  }

  const fromSecret = parseBackgroundRemovalSecret(raw);
  const endpoint =
    process.env.BACKGROUND_REMOVAL_ENDPOINT?.trim() || fromSecret.endpoint;
  if (!endpoint) {
    throw new RetryableProcessingError(
      'Background removal endpoint is not configured.',
    );
  }
  if (!fromSecret.apiKey) {
    throw new RetryableProcessingError('Background removal API key is empty.');
  }

  return {
    apiKey: fromSecret.apiKey,
    endpoint,
    fieldName: fromSecret.fieldName,
  };
}

export function createHttpBackgroundRemovalClient(
  config: HttpBackgroundRemovalConfig,
  fetchImpl: typeof fetch = fetch,
): BackgroundRemovalClient {
  return {
    removeBackground(image, contentType) {
      return postImageForBackgroundRemoval(image, contentType, config, fetchImpl);
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
  return createHttpBackgroundRemovalClient(config, deps.fetchImpl ?? fetch);
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

async function postImageForBackgroundRemoval(
  image: Uint8Array,
  contentType: string,
  config: HttpBackgroundRemovalConfig,
  fetchImpl: typeof fetch,
): Promise<Uint8Array> {
  const fieldName = config.fieldName?.trim() || DEFAULT_FIELD_NAME;
  const form = new FormData();
  form.append(
    fieldName,
    new Blob([image], { type: contentType }),
    'original',
  );

  let response: Response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        'X-Api-Key': config.apiKey,
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: form,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    throw toRetryable(error, 'Background removal provider request failed');
  }

  if (!response.ok) {
    throw classifyProviderStatus(response.status);
  }

  return new Uint8Array(await response.arrayBuffer());
}

function classifyProviderStatus(status: number): never {
  if (status === 429 || status === 401 || status === 403 || status >= 500) {
    throw new RetryableProcessingError(
      `Background removal provider returned ${status}`,
    );
  }
  throw new PermanentProcessingError(
    `Background removal rejected the image (${status})`,
  );
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

function toRetryable(error: unknown, fallback: string): RetryableProcessingError {
  if (error instanceof RetryableProcessingError) {
    return error;
  }
  return new RetryableProcessingError(
    error instanceof Error ? error.message : fallback,
    error,
  );
}
