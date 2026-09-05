import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { keys, updateAttributes } from '../../shared/dynamodb';
import { nowIso } from '../../shared/ids';
import { logger } from '../../shared/logger';
import { bucketName } from '../../shared/s3';
import {
  CLOTHING_CATEGORIES,
  ClothingCategory,
  ClothingSubcategory,
  DynamoItem,
  GarmentAiMetadata,
  SUBCATEGORIES_BY_CATEGORY,
} from '../../shared/types';
import {
  PermanentProcessingError,
  RetryableProcessingError,
} from './errors';
import type { ProcessingContext } from './pipeline';

export interface GarmentClassification {
  detectedCategory: ClothingCategory;
  detectedSubcategory: ClothingSubcategory;
}

export interface ClassifyGarmentInput {
  imageKey: string;
  context: ProcessingContext;
}

export interface GarmentClassifier {
  classify(input: ClassifyGarmentInput): Promise<GarmentClassification>;
}

export interface ClassifyGarmentDeps {
  classifier?: GarmentClassifier;
  persistAi?: (
    context: ProcessingContext,
    classification: GarmentClassification,
  ) => Promise<void>;
}

export interface ClassifierSecret {
  apiKey: string;
  endpoint: string;
}

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface HttpGarmentClassifierOptions {
  fetchSecret?: () => Promise<ClassifierSecret>;
  getImage?: (imageKey: string) => Promise<{
    bytes: Uint8Array;
    contentType: string;
  }>;
  httpPost?: FetchLike;
}

const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedSecret: ClassifierSecret | undefined;
let cachedSecretAt = 0;

const SUBCATEGORY_ALIASES: Record<string, ClothingSubcategory> = {
  T_SHIRT: 'TSHIRT',
  TEE: 'TSHIRT',
  TEES: 'TSHIRT',
  PANTS: 'TROUSERS',
  TROUSER: 'TROUSERS',
  JEAN: 'JEANS',
  HOODY: 'HOODIE',
  JUMP_SUIT: 'JUMPSUIT',
  SNEAKER: 'SNEAKERS',
  BOOT: 'BOOTS',
  HEEL: 'HEELS',
  SANDAL: 'SANDALS',
  FLAT: 'FLATS',
  JEWELERY: 'JEWELRY',
  JEWELLERY: 'JEWELRY',
  SUN_GLASSES: 'SUNGLASSES',
  HAND_BAG: 'HANDBAG',
  CROSS_BODY: 'CROSSBODY',
};

/**
 * WARDROBE-19: classify the garment and persist under `ai` only.
 * User-set `category` / `subcategory` are never overwritten.
 */
export async function classifyGarment(
  context: ProcessingContext,
  deps: ClassifyGarmentDeps = {},
): Promise<void> {
  const imageKey = resolveClassificationImageKey(context);
  const classifier = deps.classifier ?? createHttpGarmentClassifier();
  const persistAi = deps.persistAi ?? persistClassification;

  let classification: GarmentClassification;
  try {
    classification = await classifier.classify({ imageKey, context });
  } catch (error) {
    throw wrapClassifierError(error, 'Garment classification failed');
  }

  const controlled = toControlledClassification(classification);
  if (!controlled) {
    throw new PermanentProcessingError(
      'Classifier returned an uncontrolled category or subcategory',
    );
  }

  try {
    await persistAi(context, controlled);
  } catch (error) {
    throw wrapPersistError(error);
  }

  logger.info('Persisted AI garment classification', {
    itemId: context.itemId,
    wardrobeId: context.wardrobeId,
    imageKey,
    detectedCategory: controlled.detectedCategory,
    detectedSubcategory: controlled.detectedSubcategory,
  });
}

export function resolveClassificationImageKey(
  context: ProcessingContext,
): string {
  const processedKey = itemString(context.item, 'processedKey');
  if (processedKey) {
    return processedKey;
  }

  const ai = asAiMetadata(context.item.ai);
  if (ai?.processedImageKey && ai.processedImageKey.trim()) {
    return ai.processedImageKey.trim();
  }

  if (context.originalImageKey.trim()) {
    return context.originalImageKey;
  }

  const originalKey = itemString(context.item, 'originalKey');
  if (originalKey) {
    return originalKey;
  }

  throw new PermanentProcessingError(
    'No image key available for garment classification',
  );
}

export function toControlledClassification(
  value: unknown,
): GarmentClassification | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const category = canonicalizeCategory(
    raw.detectedCategory ?? raw.category,
  );
  const subcategory = canonicalizeSubcategory(
    raw.detectedSubcategory ?? raw.subcategory,
  );

  if (!category || !subcategory) {
    return undefined;
  }

  const allowed = SUBCATEGORIES_BY_CATEGORY[category];
  if (!allowed.includes(subcategory)) {
    return undefined;
  }

  return { detectedCategory: category, detectedSubcategory: subcategory };
}

export function createHttpGarmentClassifier(
  options: HttpGarmentClassifierOptions = {},
): GarmentClassifier {
  const fetchSecret = options.fetchSecret ?? loadClassifierSecret;
  const getImage = options.getImage ?? getClassificationImage;
  const httpPost = options.httpPost ?? defaultFetch;

  return {
    async classify(input: ClassifyGarmentInput): Promise<GarmentClassification> {
      const secret = await fetchSecret();
      const image = await getImage(input.imageKey);

      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await httpPost(secret.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${secret.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            imageKey: input.imageKey,
            imageBase64: Buffer.from(image.bytes).toString('base64'),
            contentType: image.contentType,
          }),
        });
      } catch (error) {
        throw new RetryableProcessingError(
          error instanceof Error
            ? error.message
            : 'Classifier HTTP request failed',
          error,
        );
      }

      if (response.status === 429 || response.status >= 500) {
        throw new RetryableProcessingError(
          `Classifier HTTP ${response.status}`,
        );
      }

      if (response.status === 401 || response.status === 403) {
        throw new PermanentProcessingError(
          'Classifier rejected the configured credentials',
        );
      }

      if (!response.ok) {
        throw new PermanentProcessingError(
          `Classifier HTTP ${response.status}`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(await response.text());
      } catch {
        throw new PermanentProcessingError(
          'Classifier returned a non-JSON body',
        );
      }

      const classification = toControlledClassification(parsed);
      if (!classification) {
        throw new PermanentProcessingError(
          'Classifier response was not a controlled garment classification',
        );
      }

      return classification;
    },
  };
}

export function resetClassifierSecretCache(): void {
  cachedSecret = undefined;
  cachedSecretAt = 0;
}

async function persistClassification(
  context: ProcessingContext,
  classification: GarmentClassification,
): Promise<void> {
  const existing = asAiMetadata(context.item.ai) ?? {};
  const ai: GarmentAiMetadata = {
    ...existing,
    detectedCategory: classification.detectedCategory,
    detectedSubcategory: classification.detectedSubcategory,
  };

  await updateAttributes(
    keys.wardrobePk(context.wardrobeId),
    keys.itemSk(context.itemId),
    {
      ai,
      updatedAt: nowIso(),
    },
  );

  // Keep in-memory ai in sync so later pipeline steps (colour) can merge.
  context.item.ai = ai;
}

async function loadClassifierSecret(): Promise<ClassifierSecret> {
  if (cachedSecret && Date.now() - cachedSecretAt < SECRET_CACHE_TTL_MS) {
    return cachedSecret;
  }

  const secretId = process.env.AI_CLASSIFIER_SECRET_ARN;
  if (!secretId) {
    throw new PermanentProcessingError(
      'AI_CLASSIFIER_SECRET_ARN is not configured',
    );
  }

  const secrets = new SecretsManagerClient({});
  let result: { SecretString?: string };
  try {
    result = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
  } catch (error) {
    if (
      error instanceof PermanentProcessingError ||
      error instanceof RetryableProcessingError
    ) {
      throw error;
    }
    throw new RetryableProcessingError(
      error instanceof Error
        ? error.message
        : 'Failed to load classifier credentials',
      error,
    );
  }

  const parsed = parseClassifierSecret(result.SecretString);
  cachedSecret = parsed;
  cachedSecretAt = Date.now();
  return parsed;
}

export function parseClassifierSecret(
  secretString: string | undefined,
): ClassifierSecret {
  const endpointFromEnv = process.env.AI_CLASSIFIER_ENDPOINT?.trim();

  if (!secretString?.trim()) {
    throw new PermanentProcessingError('AI classifier secret is empty');
  }

  const trimmed = secretString.trim();
  if (trimmed.startsWith('{')) {
    let parsed: { apiKey?: unknown; endpoint?: unknown };
    try {
      parsed = JSON.parse(trimmed) as { apiKey?: unknown; endpoint?: unknown };
    } catch {
      throw new PermanentProcessingError(
        'AI classifier secret is not valid JSON',
      );
    }

    const apiKey =
      typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
    const endpoint =
      (typeof parsed.endpoint === 'string' ? parsed.endpoint.trim() : '') ||
      endpointFromEnv ||
      '';

    if (!apiKey) {
      throw new PermanentProcessingError(
        'AI classifier secret is missing apiKey',
      );
    }
    if (!endpoint) {
      throw new PermanentProcessingError(
        'AI classifier secret is missing endpoint',
      );
    }

    return { apiKey, endpoint };
  }

  if (!endpointFromEnv) {
    throw new PermanentProcessingError(
      'AI_CLASSIFIER_ENDPOINT is required when the secret is a raw API key',
    );
  }

  return { apiKey: trimmed, endpoint: endpointFromEnv };
}

async function getClassificationImage(imageKey: string): Promise<{
  bytes: Uint8Array;
  contentType: string;
}> {
  const s3 = new S3Client({});
  try {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: bucketName(),
        Key: imageKey,
      }),
    );

    if (!result.Body || typeof result.Body.transformToByteArray !== 'function') {
      throw new PermanentProcessingError(
        'Classification image body was empty',
      );
    }

    const bytes = await result.Body.transformToByteArray();
    if (!bytes.byteLength) {
      throw new PermanentProcessingError('Classification image was empty');
    }

    return {
      bytes,
      contentType: result.ContentType ?? 'application/octet-stream',
    };
  } catch (error) {
    if (
      error instanceof PermanentProcessingError ||
      error instanceof RetryableProcessingError
    ) {
      throw error;
    }

    if (
      error instanceof Error &&
      (error.name === 'NoSuchKey' ||
        error.name === 'NotFound' ||
        error.name === 'AccessDenied')
    ) {
      throw new PermanentProcessingError(
        `Classification image is not readable: ${imageKey}`,
      );
    }

    throw new RetryableProcessingError(
      error instanceof Error
        ? error.message
        : 'Failed to load classification image',
      error,
    );
  }
}

function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ ok: boolean; status: number; text(): Promise<string> }> {
  return fetch(url, init);
}

function wrapClassifierError(error: unknown, fallback: string): Error {
  if (
    error instanceof PermanentProcessingError ||
    error instanceof RetryableProcessingError
  ) {
    return error;
  }

  return new RetryableProcessingError(
    error instanceof Error ? error.message : fallback,
    error,
  );
}

function wrapPersistError(error: unknown): Error {
  if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
    return new PermanentProcessingError(
      'Clothing item disappeared during classification persist',
    );
  }
  return wrapClassifierError(error, 'Failed to persist AI classification');
}

function canonicalizeCategory(value: unknown): ClothingCategory | undefined {
  const normalized = normalizeToken(value);
  if (!normalized) {
    return undefined;
  }
  if ((CLOTHING_CATEGORIES as readonly string[]).includes(normalized)) {
    return normalized as ClothingCategory;
  }
  return undefined;
}

function canonicalizeSubcategory(
  value: unknown,
): ClothingSubcategory | undefined {
  const normalized = normalizeToken(value);
  if (!normalized) {
    return undefined;
  }

  const aliased = SUBCATEGORY_ALIASES[normalized] ?? normalized;
  for (const subcategories of Object.values(SUBCATEGORIES_BY_CATEGORY)) {
    if ((subcategories as readonly string[]).includes(aliased)) {
      return aliased as ClothingSubcategory;
    }
  }
  return undefined;
}

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return normalized || undefined;
}

function itemString(item: DynamoItem, field: string): string | undefined {
  const value = item[field];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asAiMetadata(value: unknown): GarmentAiMetadata | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return { ...(value as GarmentAiMetadata) };
}
