import { keys, updateAttributes } from '../../shared/dynamodb';
import { nowIso } from '../../shared/ids';
import { logger } from '../../shared/logger';
import { getObjectBytes } from '../../shared/s3';
import { getSecretString } from '../../shared/secrets';
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
import {
  DEFAULT_GEMINI_CLASSIFIER_MODEL,
  GEMINI_PROVIDER_TIMEOUT_MS,
  classifyGeminiHttpStatus,
  extractGeminiText,
  geminiBlockReason,
  geminiGenerateContentUrl,
  parseGeminiApiSecret,
  parseGeminiJsonText,
  resolveGeminiImageMimeType,
  type GeminiGenerateContentConfig,
} from './gemini';
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
  loadConfig?: () => Promise<GeminiClassifierConfig>;
  fetchImpl?: typeof fetch;
  getImage?: (imageKey: string) => Promise<{
    bytes: Uint8Array;
    contentType: string;
  }>;
}

export type GeminiClassifierConfig = GeminiGenerateContentConfig;

export interface ClassifierSecret extends GeminiClassifierConfig {}

export interface GeminiGarmentClassifierOptions {
  config?: GeminiClassifierConfig;
  fetchSecret?: () => Promise<GeminiClassifierConfig>;
  loadConfig?: () => Promise<GeminiClassifierConfig>;
  getImage?: (imageKey: string) => Promise<{
    bytes: Uint8Array;
    contentType: string;
  }>;
  fetchImpl?: typeof fetch;
}

const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedSecret: GeminiClassifierConfig | undefined;
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
 * WARDROBE-19/27: classify the garment and persist under `ai` only.
 * User-set `category` / `subcategory` are never overwritten.
 * Deployed default is Gemini generateContent; tests inject a mock classifier.
 */
export async function classifyGarment(
  context: ProcessingContext,
  deps: ClassifyGarmentDeps = {},
): Promise<void> {
  const imageKey = resolveClassificationImageKey(context);
  const classifier = deps.classifier ?? (await defaultClassifier(deps));
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

export function createGeminiGarmentClassifier(
  configOrOptions: GeminiClassifierConfig | GeminiGarmentClassifierOptions,
  fetchImpl?: typeof fetch,
): GarmentClassifier {
  if (isClassifierConfig(configOrOptions)) {
    return buildGeminiClassifier({
      config: configOrOptions,
      fetchImpl,
    });
  }
  return buildGeminiClassifier(configOrOptions);
}

async function defaultClassifier(
  deps: ClassifyGarmentDeps,
): Promise<GarmentClassifier> {
  return buildGeminiClassifier({
    loadConfig: deps.loadConfig,
    fetchImpl: deps.fetchImpl,
    getImage: deps.getImage,
  });
}

function buildGeminiClassifier(
  options: GeminiGarmentClassifierOptions & { config?: GeminiClassifierConfig },
): GarmentClassifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const getImage = options.getImage ?? getClassificationImage;
  const loadConfig =
    options.loadConfig ??
    options.fetchSecret ??
    (options.config
      ? async () => options.config as GeminiClassifierConfig
      : loadClassifierConfig);

  return {
    async classify(input: ClassifyGarmentInput): Promise<GarmentClassification> {
      const config = await loadConfig();
      const image = await getImage(input.imageKey);
      return classifyWithGemini(image, config, fetchImpl);
    },
  };
}

export function resetClassifierSecretCache(): void {
  cachedSecret = undefined;
  cachedSecretAt = 0;
}

export async function loadClassifierConfig(
  getSecret: (secretId: string) => Promise<string> = getSecretString,
): Promise<GeminiClassifierConfig> {
  if (cachedSecret && Date.now() - cachedSecretAt < SECRET_CACHE_TTL_MS) {
    return cachedSecret;
  }

  const secretId = process.env.AI_CLASSIFIER_SECRET_ARN;
  if (!secretId) {
    throw new RetryableProcessingError(
      'AI_CLASSIFIER_SECRET_ARN is not configured.',
    );
  }

  let raw: string;
  try {
    raw = await getSecret(secretId);
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
        : 'Failed to read Gemini classifier secret',
      error,
    );
  }

  const fromSecret = parseClassifierSecret(raw);
  const model =
    process.env.GEMINI_CLASSIFIER_MODEL?.trim() ||
    fromSecret.model ||
    DEFAULT_GEMINI_CLASSIFIER_MODEL;
  const endpoint =
    process.env.GEMINI_CLASSIFIER_ENDPOINT?.trim() ||
    fromSecret.endpoint ||
    geminiGenerateContentUrl(model);

  const config = {
    apiKey: fromSecret.apiKey,
    model,
    endpoint,
  };
  cachedSecret = config;
  cachedSecretAt = Date.now();
  return config;
}

export function parseClassifierSecret(
  secretString: string | undefined,
): GeminiClassifierConfig {
  if (!secretString?.trim()) {
    throw new RetryableProcessingError('Gemini classifier secret is empty.');
  }
  return parseGeminiApiSecret(secretString, DEFAULT_GEMINI_CLASSIFIER_MODEL);
}

export function classificationPrompt(): string {
  const taxonomy = (CLOTHING_CATEGORIES as readonly ClothingCategory[])
    .map((category) => {
      const subs = SUBCATEGORIES_BY_CATEGORY[category].join(', ');
      return `${category}: ${subs}`;
    })
    .join('\n');

  return [
    'Classify this clothing item. Return JSON only with this exact shape:',
    '{"detectedCategory":"TOP","detectedSubcategory":"TSHIRT"}',
    '',
    'detectedCategory must be one of: TOP, BOTTOM, DRESS, OUTERWEAR, SHOES, ACCESSORY, BAG.',
    'detectedSubcategory must belong to that category:',
    taxonomy,
    '',
    'Do not invent tokens. Do not include markdown, commentary, or extra keys.',
  ].join('\n');
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

async function classifyWithGemini(
  image: { bytes: Uint8Array; contentType: string },
  config: GeminiClassifierConfig,
  fetchImpl: typeof fetch,
): Promise<GarmentClassification> {
  const mimeType = resolveGeminiImageMimeType(image.bytes, image.contentType);
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: classificationPrompt() },
          {
            inlineData: {
              mimeType,
              data: Buffer.from(image.bytes).toString('base64'),
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0,
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
    throw new RetryableProcessingError(
      error instanceof Error
        ? error.message
        : 'Gemini classification request failed',
      error,
    );
  }

  if (!response.ok) {
    classifyGeminiHttpStatus(response.status, 'Gemini classifier');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new PermanentProcessingError(
      'Gemini classifier returned a non-JSON body.',
    );
  }

  const blocked = geminiBlockReason(payload);
  if (blocked) {
    throw new PermanentProcessingError(
      `Gemini blocked the clothing image (${blocked})`,
    );
  }

  const text = extractGeminiText(payload);
  if (!text) {
    throw new PermanentProcessingError(
      'Gemini did not return a garment classification.',
    );
  }

  let parsed: unknown;
  try {
    parsed = parseGeminiJsonText(text);
  } catch {
    throw new PermanentProcessingError(
      'Gemini classifier returned a non-JSON classification.',
    );
  }

  const classification = toControlledClassification(parsed);
  if (!classification) {
    throw new PermanentProcessingError(
      'Gemini classifier response was not a controlled garment classification',
    );
  }

  return classification;
}

async function getClassificationImage(imageKey: string): Promise<{
  bytes: Uint8Array;
  contentType: string;
}> {
  try {
    const result = await getObjectBytes(imageKey);
    if (!result.bytes?.byteLength) {
      throw new PermanentProcessingError('Classification image was empty');
    }
    return {
      bytes: result.bytes,
      contentType: result.contentType ?? 'application/octet-stream',
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

function isClassifierConfig(
  value: GeminiClassifierConfig | GeminiGarmentClassifierOptions,
): value is GeminiClassifierConfig {
  return (
    typeof (value as GeminiClassifierConfig).apiKey === 'string' &&
    typeof (value as GeminiClassifierConfig).endpoint === 'string' &&
    typeof (value as GeminiClassifierConfig).model === 'string' &&
    !('fetchImpl' in value) &&
    !('getImage' in value) &&
    !('loadConfig' in value) &&
    !('fetchSecret' in value)
  );
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
