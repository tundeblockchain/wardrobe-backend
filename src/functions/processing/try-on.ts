import { logger } from '../../shared/logger';
import {
  getObjectBytes,
  MAX_UPLOAD_BYTES,
  outfitRenderObjectKey,
  putObjectBytes,
} from '../../shared/s3';
import { getSecretString } from '../../shared/secrets';
import { PermanentProcessingError, RetryableProcessingError } from './errors';
import {
  DEFAULT_GEMINI_TRY_ON_MODEL,
  GEMINI_PROVIDER_TIMEOUT_MS,
  classifyGeminiHttpStatus,
  extractGeminiInlineImage,
  geminiBlockReason,
  geminiGenerateContentUrl,
  parseGeminiApiSecret,
  resolveGeminiImageMimeType,
} from './gemini';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RENDER_CONTENT_TYPE = 'image/png';
const MAX_PROFILE_REFERENCE_IMAGES = 3;

export const DEFAULT_GEMINI_MODEL = DEFAULT_GEMINI_TRY_ON_MODEL;
export { geminiGenerateContentUrl };

const TRY_ON_PROMPT =
  'Create a single photorealistic virtual try-on image. The first image(s) show the person or model. The following images are garments from one outfit, each labeled by clothing slot. Dress that same person in those garments. Keep the person\'s face, body shape, skin tone, hair, and pose. Fit the clothes naturally. Do not add extra garments, accessories, logos, or text. Return one full-body PNG.';

export interface TryOnImage {
  label: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface TryOnClient {
  render(images: TryOnImage[]): Promise<Uint8Array>;
}

export interface GeminiTryOnConfig {
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

export interface TryOnDeps {
  store?: ObjectStore;
  client?: TryOnClient;
  loadConfig?: () => Promise<GeminiTryOnConfig>;
  fetchImpl?: typeof fetch;
}

export function parseTryOnSecret(secretString: string): GeminiTryOnConfig {
  return parseGeminiApiSecret(secretString, DEFAULT_GEMINI_MODEL);
}

export async function loadTryOnConfig(
  getSecret: (secretId: string) => Promise<string> = getSecretString,
): Promise<GeminiTryOnConfig> {
  const secretId = process.env.GEMINI_TRY_ON_SECRET_ARN;
  if (!secretId) {
    throw new RetryableProcessingError(
      'GEMINI_TRY_ON_SECRET_ARN is not configured.',
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
        : 'Failed to read Gemini try-on secret',
      error,
    );
  }

  const fromSecret = parseTryOnSecret(raw);
  if (!fromSecret.apiKey) {
    throw new RetryableProcessingError('Gemini API key is empty.');
  }

  const model =
    process.env.GEMINI_TRY_ON_MODEL?.trim() ||
    fromSecret.model ||
    DEFAULT_GEMINI_MODEL;
  const endpoint =
    process.env.GEMINI_TRY_ON_ENDPOINT?.trim() ||
    fromSecret.endpoint ||
    geminiGenerateContentUrl(model);

  return {
    apiKey: fromSecret.apiKey,
    model,
    endpoint,
  };
}

export function createGeminiTryOnClient(
  config: GeminiTryOnConfig,
  fetchImpl: typeof fetch = fetch,
): TryOnClient {
  return {
    render(images) {
      return generateTryOnPng(images, config, fetchImpl);
    },
  };
}

export async function runOutfitTryOn(
  input: {
    userId: string;
    outfitId: string;
    profileImageKeys: string[];
    garmentImages: Array<{ slot: string; objectKey: string }>;
  },
  deps: TryOnDeps = {},
): Promise<string> {
  const profileKeys = input.profileImageKeys
    .map((key) => key.trim())
    .filter(Boolean)
    .slice(0, MAX_PROFILE_REFERENCE_IMAGES);
  if (profileKeys.length === 0) {
    throw new PermanentProcessingError(
      'AI profile has no reference images to render against.',
    );
  }
  if (input.garmentImages.length === 0) {
    throw new PermanentProcessingError('Outfit has no garment images to render.');
  }

  const store = deps.store ?? defaultObjectStore();
  const client = deps.client ?? (await defaultClient(deps));

  const images: TryOnImage[] = [];
  for (const [index, objectKey] of profileKeys.entries()) {
    const original = await readImage(store, objectKey);
    images.push({
      label: `Person reference ${index + 1}`,
      bytes: original.bytes,
      contentType: original.contentType,
    });
  }
  for (const garment of input.garmentImages) {
    const original = await readImage(store, garment.objectKey);
    images.push({
      label: `Garment ${garment.slot}`,
      bytes: original.bytes,
      contentType: original.contentType,
    });
  }

  const rendered = await invokeClient(client, images);
  const imageKey = outfitRenderObjectKey(input.userId, input.outfitId);

  try {
    await store.putObject(imageKey, rendered, RENDER_CONTENT_TYPE);
  } catch (error) {
    throw toRetryable(error, 'Failed to write outfit render image');
  }

  logger.info('Outfit try-on render stored', {
    outfitId: input.outfitId,
    imageKey,
    profileImages: profileKeys.length,
    garments: input.garmentImages.length,
  });

  return imageKey;
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

async function defaultClient(deps: TryOnDeps): Promise<TryOnClient> {
  const loadConfig = deps.loadConfig ?? loadTryOnConfig;
  const config = await loadConfig();
  return createGeminiTryOnClient(config, deps.fetchImpl ?? fetch);
}

async function readImage(
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
    throw new PermanentProcessingError(`Image ${objectKey} is empty.`);
  }
  if (original.bytes.length > MAX_UPLOAD_BYTES) {
    throw new PermanentProcessingError(
      `Image exceeds the ${MAX_UPLOAD_BYTES} byte limit: ${objectKey}`,
    );
  }

  return {
    bytes: original.bytes,
    contentType: original.contentType?.trim() || 'application/octet-stream',
  };
}

async function invokeClient(
  client: TryOnClient,
  images: TryOnImage[],
): Promise<Uint8Array> {
  let rendered: Uint8Array;
  try {
    rendered = await client.render(images);
  } catch (error) {
    if (
      error instanceof PermanentProcessingError ||
      error instanceof RetryableProcessingError
    ) {
      throw error;
    }
    throw toRetryable(error, 'Outfit try-on failed');
  }

  if (!isPng(rendered)) {
    throw new PermanentProcessingError(
      'Outfit try-on did not return a PNG image.',
    );
  }

  return rendered;
}

async function generateTryOnPng(
  images: TryOnImage[],
  config: GeminiTryOnConfig,
  fetchImpl: typeof fetch,
): Promise<Uint8Array> {
  const parts: Array<Record<string, unknown>> = [{ text: TRY_ON_PROMPT }];
  for (const image of images) {
    const mimeType = resolveGeminiImageMimeType(image.bytes, image.contentType);
    parts.push({ text: image.label });
    parts.push({
      inlineData: {
        mimeType,
        data: Buffer.from(image.bytes).toString('base64'),
      },
    });
  }

  const body = {
    contents: [
      {
        role: 'user',
        parts,
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
    throw toRetryable(error, 'Gemini try-on request failed');
  }

  if (!response.ok) {
    classifyGeminiHttpStatus(response.status, 'Gemini try-on');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new PermanentProcessingError('Gemini try-on returned a non-JSON body.');
  }

  const blocked = geminiBlockReason(payload);
  if (blocked) {
    throw new PermanentProcessingError(
      `Gemini blocked the try-on request (${blocked})`,
    );
  }

  const rendered = extractGeminiInlineImage(payload);
  if (!rendered?.length) {
    throw new PermanentProcessingError(
      'Gemini did not return an image for try-on.',
    );
  }

  return rendered;
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
    throw new PermanentProcessingError(`Image not found: ${objectKey}`);
  }

  throw toRetryable(error, `Failed to read image ${objectKey}`);
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
