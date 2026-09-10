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
  detectGeminiImageMimeType,
  extractGeminiInlineImage,
  fetchGeminiGenerateContent,
  geminiBlockReason,
  geminiGenerateContentUrl,
  parseGeminiApiSecret,
  resolveGeminiGenerateContentConfig,
  resolveGeminiImageMimeType,
} from './gemini';
import { frontalReferenceImageKey } from '../ai-profiles/model';
import {
  buildTryOnPrompt,
  composeOutfitTryOn,
  garmentImageLabel,
  personImageLabel,
  type OutfitTryOnGarment,
} from './outfit-context';
import { AiProfileBodyContext } from '../../shared/types';
import { isEmptyAiProfileBodyContext } from '../ai-profiles/body-context';

const RENDER_OBJECT_CONTENT_TYPE = 'image/png';

export const DEFAULT_GEMINI_MODEL = DEFAULT_GEMINI_TRY_ON_MODEL;
export { geminiGenerateContentUrl };
export type { OutfitTryOnGarment };

const TRY_ON_PROMPT =
  'Generate a NEW photorealistic fashion photograph of this person wearing the garments. The person image is identity only. Reconstruct each garment on the body with realistic drape. Do not overlay or paste garment images onto the person photo. A cute indoor room is optional. Return one full-body image.';

export interface TryOnImage {
  label: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface TryOnClient {
  render(images: TryOnImage[], prompt?: string): Promise<Uint8Array>;
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

  return resolveGeminiGenerateContentConfig(fromSecret, {
    defaultModel: DEFAULT_GEMINI_MODEL,
    modelOverride: process.env.GEMINI_TRY_ON_MODEL,
    endpointOverride: process.env.GEMINI_TRY_ON_ENDPOINT,
  });
}

export function createGeminiTryOnClient(
  config: GeminiTryOnConfig,
  fetchImpl: typeof fetch = fetch,
): TryOnClient {
  return {
    render(images, prompt) {
      return generateTryOnPng(images, config, fetchImpl, prompt);
    },
  };
}

export async function runOutfitTryOn(
  input: {
    userId: string;
    outfitId: string;
    profileImageKeys: string[];
    garmentImages: OutfitTryOnGarment[];
    profileBody?: AiProfileBodyContext;
  },
  deps: TryOnDeps = {},
): Promise<string> {
  const profileKeys = selectTryOnProfileImageKeys(input.profileImageKeys);
  if (profileKeys.length === 0) {
    throw new PermanentProcessingError(
      'AI profile has no reference images to render against.',
    );
  }
  if (input.garmentImages.length === 0) {
    throw new PermanentProcessingError('Outfit has no garment images to render.');
  }

  const composed = composeOutfitTryOn(input.garmentImages);
  const prompt = buildTryOnPrompt(
    composed,
    isEmptyAiProfileBodyContext(input.profileBody)
      ? undefined
      : input.profileBody,
  );
  if (composed.worn.length === 0) {
    throw new PermanentProcessingError(
      'Outfit has no compatible garments to render together.',
    );
  }

  const store = deps.store ?? defaultObjectStore();
  const client = deps.client ?? (await defaultClient(deps));

  const images: TryOnImage[] = [];
  for (const objectKey of profileKeys) {
    const original = await readImage(store, objectKey);
    images.push({
      label: personImageLabel(),
      bytes: original.bytes,
      contentType: original.contentType,
    });
  }
  for (const garment of composed.worn) {
    const original = await readImage(store, garment.objectKey);
    images.push({
      label: garmentImageLabel(garment),
      bytes: original.bytes,
      contentType: original.contentType,
    });
  }

  const rendered = await invokeClient(client, images, prompt);
  const imageKey = outfitRenderObjectKey(input.userId, input.outfitId);
  const contentType =
    detectGeminiImageMimeType(rendered) ?? RENDER_OBJECT_CONTENT_TYPE;

  try {
    await store.putObject(imageKey, rendered, contentType);
  } catch (error) {
    throw toRetryable(error, 'Failed to write outfit render image');
  }

  logger.info('Outfit try-on render stored', {
    outfitId: input.outfitId,
    imageKey,
    profileImages: profileKeys.length,
    garments: input.garmentImages.length,
    wornGarments: composed.worn.length,
    omittedGarments: composed.omitted.length,
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

function selectTryOnProfileImageKeys(profileImageKeys: string[]): string[] {
  const front = frontalReferenceImageKey(profileImageKeys);
  return front ? [front] : [];
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
  prompt: string,
): Promise<Uint8Array> {
  let rendered: Uint8Array;
  try {
    rendered = await client.render(images, prompt);
  } catch (error) {
    if (
      error instanceof PermanentProcessingError ||
      error instanceof RetryableProcessingError
    ) {
      throw error;
    }
    throw toRetryable(error, 'Outfit try-on failed');
  }

  if (!detectGeminiImageMimeType(rendered)) {
    throw new PermanentProcessingError(
      'Outfit try-on did not return a PNG or JPEG image.',
    );
  }

  return rendered;
}

async function generateTryOnPng(
  images: TryOnImage[],
  config: GeminiTryOnConfig,
  fetchImpl: typeof fetch,
  prompt = TRY_ON_PROMPT,
): Promise<Uint8Array> {
  const parts: Array<Record<string, unknown>> = [];
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
  parts.push({ text: prompt });

  const body = {
    contents: [
      {
        role: 'user',
        parts,
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: {
        aspectRatio: '3:4',
        imageSize: '1K',
      },
    },
  };

  const response = await fetchGeminiGenerateContent(config, body, fetchImpl, {
    stage: 'try-on',
    label: 'Gemini try-on',
    networkErrorMessage: 'Gemini try-on request failed',
  });

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

function toRetryable(error: unknown, fallback: string): RetryableProcessingError {
  if (error instanceof RetryableProcessingError) {
    return error;
  }
  return new RetryableProcessingError(
    error instanceof Error ? error.message : fallback,
    error,
  );
}
