import { keys, updateAttributes } from '../../shared/dynamodb';
import { nowIso } from '../../shared/ids';
import { logger } from '../../shared/logger';
import { getObjectBytes } from '../../shared/s3';
import { getSecretString, parseJsonObjectOrString } from '../../shared/secrets';
import {
  CLOTHING_CATEGORIES,
  CLOTHING_COLOURS,
  ClothingCategory,
  ClothingColour,
  ClothingSubcategory,
  GarmentAiMetadata,
} from '../../shared/types';
import {
  toControlledClassification,
  resolveClassificationImageKey,
} from './classify';
import {
  PermanentProcessingError,
  RetryableProcessingError,
} from './errors';
import {
  classifyGeminiHttpStatus,
  DEFAULT_GEMINI_COLOUR_MODEL,
  extractGeminiText,
  firstString,
  geminiBlockReason,
  geminiGenerateContentUrl,
  GEMINI_PROVIDER_TIMEOUT_MS,
  parseGeminiJsonText,
  resolveGeminiImageMimeType,
} from './gemini';
import type { ProcessingContext } from './pipeline';

export const MAX_DETECTED_COLOURS = 8;

export { DEFAULT_GEMINI_COLOUR_MODEL };
export const COLOUR_DETECTOR_STRATEGY_GEMINI = 'gemini';
export const COLOUR_DETECTOR_STRATEGY_HTTP = 'http';

const COLOUR_DETECTION_PROMPT = [
  'Identify the clothing item colours in this image, and optionally refine its category.',
  'Return JSON only with this shape:',
  '{ "detectedColours": ["BLACK"], "detectedCategory": "TOP", "detectedSubcategory": "TSHIRT" }',
  `detectedColours is required. Use only these colour tokens: ${CLOTHING_COLOURS.join(', ')}.`,
  'Order colours by visual dominance. At most 8. De-duplicate. Do not invent colours.',
  `detectedCategory if present must be one of: ${CLOTHING_CATEGORIES.join(', ')}.`,
  'detectedSubcategory if present must be a controlled subcategory for that category.',
  'Omit category fields when you are not confident.',
].join(' ');

export interface ColourDetection {
  detectedColours: ClothingColour[];
  detectedCategory?: ClothingCategory;
  detectedSubcategory?: ClothingSubcategory;
}

export interface DetectColourInput {
  imageKey: string;
  context: ProcessingContext;
}

export interface ColourDetector {
  detect(input: DetectColourInput): Promise<ColourDetection>;
}

export interface DetectColourAndCategoryDeps {
  detector?: ColourDetector;
  persistAi?: (
    context: ProcessingContext,
    detection: ColourDetection,
  ) => Promise<void>;
}

export interface ColourDetectorSecret {
  apiKey: string;
  endpoint: string;
}

export interface GeminiColourDetectorConfig {
  apiKey: string;
  model: string;
  endpoint: string;
}

export type ColourDetectorStrategy =
  | typeof COLOUR_DETECTOR_STRATEGY_GEMINI
  | typeof COLOUR_DETECTOR_STRATEGY_HTTP;

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

export interface HttpColourDetectorOptions {
  fetchSecret?: () => Promise<ColourDetectorSecret>;
  getImage?: (imageKey: string) => Promise<{
    bytes: Uint8Array;
    contentType: string;
  }>;
  httpPost?: FetchLike;
}

export interface GeminiColourDetectorOptions {
  fetchSecret?: () => Promise<GeminiColourDetectorConfig>;
  getImage?: (imageKey: string) => Promise<{
    bytes: Uint8Array;
    contentType: string;
  }>;
  fetchImpl?: typeof fetch;
}

export interface DefaultColourDetectorOptions {
  getImage?: (imageKey: string) => Promise<{
    bytes: Uint8Array;
    contentType: string;
  }>;
  httpPost?: FetchLike;
  fetchImpl?: typeof fetch;
  fetchHttpSecret?: () => Promise<ColourDetectorSecret>;
  fetchGeminiSecret?: () => Promise<GeminiColourDetectorConfig>;
}

const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedSecret: ColourDetectorSecret | undefined;
let cachedSecretAt = 0;
let cachedGeminiConfig: GeminiColourDetectorConfig | undefined;
let cachedGeminiConfigAt = 0;

const COLOUR_ALIASES: Record<string, ClothingColour> = {
  GRAY: 'GREY',
  GRAYSCALE: 'GREY',
  GREYSCALE: 'GREY',
  CHARCOAL: 'GREY',
  NAVY_BLUE: 'NAVY',
  DARK_BLUE: 'NAVY',
  OFF_WHITE: 'CREAM',
  IVORY: 'CREAM',
  MULTI: 'MULTICOLOUR',
  MULTICOLOR: 'MULTICOLOUR',
  MULTI_COLOUR: 'MULTICOLOUR',
  MULTI_COLOR: 'MULTICOLOUR',
  RAINBOW: 'MULTICOLOUR',
};

/**
 * WARDROBE-20 / WARDROBE-29: detect colours (and optionally refine category)
 * and persist under `ai` only. User-set `category` / `subcategory` /
 * `colours` are never overwritten. Deployed default is Gemini
 * generateContent; tests inject a mock or use the HTTP strategy.
 */
export async function detectColourAndCategory(
  context: ProcessingContext,
  deps: DetectColourAndCategoryDeps = {},
): Promise<void> {
  const imageKey = resolveColourDetectionImageKey(context);
  const detector = deps.detector ?? createDefaultColourDetector();
  const persistAi = deps.persistAi ?? persistColourDetection;

  let detection: ColourDetection;
  try {
    detection = await detector.detect({ imageKey, context });
  } catch (error) {
    throw wrapDetectorError(error, 'Colour detection failed');
  }

  const controlled = toControlledColourDetection(detection);
  if (!controlled) {
    throw new PermanentProcessingError(
      'Colour detector returned no controlled colour tokens',
    );
  }

  try {
    await persistAi(context, controlled);
  } catch (error) {
    throw wrapPersistError(error);
  }

  logger.info('Persisted AI colour detection', {
    itemId: context.itemId,
    wardrobeId: context.wardrobeId,
    imageKey,
    detectedColours: controlled.detectedColours,
    detectedCategory: controlled.detectedCategory,
    detectedSubcategory: controlled.detectedSubcategory,
  });
}

export function resolveColourDetectionImageKey(
  context: ProcessingContext,
): string {
  return resolveClassificationImageKey(context);
}

export function toControlledColours(value: unknown): ClothingColour[] | undefined {
  const tokens = extractColourTokens(value);
  if (!tokens) {
    return undefined;
  }

  const seen = new Set<ClothingColour>();
  const colours: ClothingColour[] = [];
  for (const token of tokens) {
    const colour = canonicalizeColour(token);
    if (!colour || seen.has(colour)) {
      continue;
    }
    seen.add(colour);
    colours.push(colour);
    if (colours.length >= MAX_DETECTED_COLOURS) {
      break;
    }
  }

  return colours.length > 0 ? colours : undefined;
}

export function toControlledColourDetection(
  value: unknown,
): ColourDetection | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    const colours = toControlledColours(value);
    return colours ? { detectedColours: colours } : undefined;
  }

  const raw = value as Record<string, unknown>;
  const colours = toControlledColours(
    raw.detectedColours ?? raw.colours ?? raw.colors ?? raw.colour ?? raw.color ?? raw,
  );
  if (!colours) {
    return undefined;
  }

  const pair = toControlledClassification(raw);
  if (pair) {
    return {
      detectedColours: colours,
      detectedCategory: pair.detectedCategory,
      detectedSubcategory: pair.detectedSubcategory,
    };
  }

  const categoryOnly = canonicalizeCategory(raw.detectedCategory ?? raw.category);
  if (categoryOnly) {
    return { detectedColours: colours, detectedCategory: categoryOnly };
  }

  return { detectedColours: colours };
}

export function createHttpColourDetector(
  options: HttpColourDetectorOptions = {},
): ColourDetector {
  const fetchSecret = options.fetchSecret ?? loadColourDetectorSecret;
  const getImage = options.getImage ?? getColourDetectionImage;
  const httpPost = options.httpPost ?? defaultFetch;

  return {
    async detect(input: DetectColourInput): Promise<ColourDetection> {
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
            : 'Colour detector HTTP request failed',
          error,
        );
      }

      if (response.status === 429 || response.status >= 500) {
        throw new RetryableProcessingError(
          `Colour detector HTTP ${response.status}`,
        );
      }

      if (response.status === 401 || response.status === 403) {
        throw new PermanentProcessingError(
          'Colour detector rejected the configured credentials',
        );
      }

      if (!response.ok) {
        throw new PermanentProcessingError(
          `Colour detector HTTP ${response.status}`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(await response.text());
      } catch {
        throw new PermanentProcessingError(
          'Colour detector returned a non-JSON body',
        );
      }

      const detection = toControlledColourDetection(parsed);
      if (!detection) {
        throw new PermanentProcessingError(
          'Colour detector response was not a controlled colour detection',
        );
      }

      return detection;
    },
  };
}

export function resolveColourDetectorStrategy(): ColourDetectorStrategy {
  const raw = process.env.COLOUR_DETECTOR_STRATEGY?.trim().toLowerCase();
  return raw === COLOUR_DETECTOR_STRATEGY_HTTP
    ? COLOUR_DETECTOR_STRATEGY_HTTP
    : COLOUR_DETECTOR_STRATEGY_GEMINI;
}

/**
 * Deployed default is Gemini. `COLOUR_DETECTOR_STRATEGY=http` keeps the
 * vendor-agnostic hook for tests and local non-Gemini paths.
 */
export function createDefaultColourDetector(
  options: DefaultColourDetectorOptions = {},
): ColourDetector {
  if (resolveColourDetectorStrategy() === COLOUR_DETECTOR_STRATEGY_HTTP) {
    return createHttpColourDetector({
      fetchSecret: options.fetchHttpSecret,
      getImage: options.getImage,
      httpPost: options.httpPost,
    });
  }
  return createGeminiColourDetector({
    fetchSecret: options.fetchGeminiSecret,
    getImage: options.getImage,
    fetchImpl: options.fetchImpl,
  });
}

export function createGeminiColourDetector(
  options: GeminiColourDetectorOptions = {},
): ColourDetector {
  const fetchSecret = options.fetchSecret ?? loadGeminiColourDetectorConfig;
  const getImage = options.getImage ?? getColourDetectionImage;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async detect(input: DetectColourInput): Promise<ColourDetection> {
      const config = await fetchSecret();
      const image = await getImage(input.imageKey);
      const payload = await postGeminiColourDetection(
        image,
        config,
        fetchImpl,
      );
      const blocked = geminiBlockReason(payload);
      if (blocked) {
        throw new PermanentProcessingError(
          `Gemini blocked the clothing image (${blocked})`,
        );
      }

      const text = extractGeminiText(payload);
      if (!text) {
        throw new PermanentProcessingError(
          'Gemini did not return colour detection text',
        );
      }

      let parsed: unknown;
      try {
        parsed = parseGeminiJsonText(text);
      } catch (error) {
        if (
          error instanceof PermanentProcessingError ||
          error instanceof RetryableProcessingError
        ) {
          throw error;
        }
        throw new PermanentProcessingError(
          'Gemini colour response was not valid JSON',
        );
      }

      const detection = toControlledColourDetection(parsed);
      if (!detection) {
        throw new PermanentProcessingError(
          'Gemini colour response was not a controlled colour detection',
        );
      }

      return detection;
    },
  };
}

export function resetColourDetectorSecretCache(): void {
  cachedSecret = undefined;
  cachedSecretAt = 0;
  cachedGeminiConfig = undefined;
  cachedGeminiConfigAt = 0;
}

export function parseColourDetectorSecret(
  secretString: string | undefined,
): ColourDetectorSecret {
  const endpointFromEnv = process.env.AI_COLOUR_DETECTOR_ENDPOINT?.trim();

  if (!secretString?.trim()) {
    throw new PermanentProcessingError('AI colour detector secret is empty');
  }

  const parsed = parseJsonObjectOrString(secretString);
  if (typeof parsed === 'string') {
    if (!endpointFromEnv) {
      throw new PermanentProcessingError(
        'AI_COLOUR_DETECTOR_ENDPOINT is required when the secret is a raw API key',
      );
    }
    return { apiKey: parsed, endpoint: endpointFromEnv };
  }

  const apiKey = firstString(parsed, ['apiKey', 'api_key', 'key']);
  const endpoint =
    firstString(parsed, ['endpoint', 'url']) || endpointFromEnv || '';

  if (!apiKey) {
    throw new PermanentProcessingError(
      'AI colour detector secret is missing apiKey',
    );
  }
  if (!endpoint) {
    throw new PermanentProcessingError(
      'AI colour detector secret is missing endpoint',
    );
  }

  return { apiKey, endpoint };
}

export function parseGeminiColourDetectorSecret(
  secretString: string | undefined,
): GeminiColourDetectorConfig {
  if (!secretString?.trim()) {
    throw new RetryableProcessingError('Gemini colour-detection secret is empty');
  }

  const parsed = parseJsonObjectOrString(secretString);
  if (typeof parsed === 'string') {
    return {
      apiKey: parsed,
      model: DEFAULT_GEMINI_COLOUR_MODEL,
      endpoint: geminiGenerateContentUrl(DEFAULT_GEMINI_COLOUR_MODEL),
    };
  }

  const apiKey = firstString(parsed, ['apiKey', 'api_key', 'key']);
  if (!apiKey) {
    throw new RetryableProcessingError(
      'Gemini colour-detection secret is missing apiKey',
    );
  }

  const model =
    firstString(parsed, ['model']) ?? DEFAULT_GEMINI_COLOUR_MODEL;
  const endpoint =
    firstString(parsed, ['endpoint', 'url']) ?? geminiGenerateContentUrl(model);

  return { apiKey, model, endpoint };
}

export async function loadGeminiColourDetectorConfig(
  getSecret: (secretId: string) => Promise<string> = getSecretString,
): Promise<GeminiColourDetectorConfig> {
  if (
    cachedGeminiConfig &&
    Date.now() - cachedGeminiConfigAt < SECRET_CACHE_TTL_MS
  ) {
    return cachedGeminiConfig;
  }

  const secretId = process.env.AI_COLOUR_DETECTOR_SECRET_ARN;
  if (!secretId) {
    throw new RetryableProcessingError(
      'AI_COLOUR_DETECTOR_SECRET_ARN is not configured',
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
        : 'Failed to load Gemini colour detector credentials',
      error,
    );
  }

  const fromSecret = parseGeminiColourDetectorSecret(raw);
  if (!fromSecret.apiKey) {
    throw new RetryableProcessingError('Gemini colour-detection API key is empty');
  }

  const model =
    process.env.GEMINI_COLOUR_MODEL?.trim() ||
    fromSecret.model ||
    DEFAULT_GEMINI_COLOUR_MODEL;
  const endpoint =
    process.env.GEMINI_COLOUR_ENDPOINT?.trim() ||
    fromSecret.endpoint ||
    geminiGenerateContentUrl(model);

  const config = { apiKey: fromSecret.apiKey, model, endpoint };
  cachedGeminiConfig = config;
  cachedGeminiConfigAt = Date.now();
  return config;
}

async function persistColourDetection(
  context: ProcessingContext,
  detection: ColourDetection,
): Promise<void> {
  const existing = asAiMetadata(context.item.ai) ?? {};
  const ai: GarmentAiMetadata = {
    ...existing,
    detectedColours: detection.detectedColours,
  };
  if (detection.detectedCategory) {
    ai.detectedCategory = detection.detectedCategory;
  }
  if (detection.detectedSubcategory) {
    ai.detectedSubcategory = detection.detectedSubcategory;
  }

  await updateAttributes(
    keys.wardrobePk(context.wardrobeId),
    keys.itemSk(context.itemId),
    {
      ai,
      updatedAt: nowIso(),
    },
  );

  context.item.ai = ai;
}

async function loadColourDetectorSecret(): Promise<ColourDetectorSecret> {
  if (cachedSecret && Date.now() - cachedSecretAt < SECRET_CACHE_TTL_MS) {
    return cachedSecret;
  }

  const secretId = process.env.AI_COLOUR_DETECTOR_SECRET_ARN;
  if (!secretId) {
    throw new PermanentProcessingError(
      'AI_COLOUR_DETECTOR_SECRET_ARN is not configured',
    );
  }

  let raw: string;
  try {
    raw = await getSecretString(secretId);
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
        : 'Failed to load colour detector credentials',
      error,
    );
  }

  const parsed = parseColourDetectorSecret(raw);
  cachedSecret = parsed;
  cachedSecretAt = Date.now();
  return parsed;
}

async function getColourDetectionImage(imageKey: string): Promise<{
  bytes: Uint8Array;
  contentType: string;
}> {
  try {
    const result = await getObjectBytes(imageKey);
    if (!result.bytes?.byteLength) {
      throw new PermanentProcessingError('Colour detection image was empty');
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
        `Colour detection image is not readable: ${imageKey}`,
      );
    }

    throw new RetryableProcessingError(
      error instanceof Error
        ? error.message
        : 'Failed to load colour detection image',
      error,
    );
  }
}

async function postGeminiColourDetection(
  image: { bytes: Uint8Array; contentType: string },
  config: GeminiColourDetectorConfig,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const mimeType = resolveGeminiImageMimeType(image.bytes, image.contentType);
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: COLOUR_DETECTION_PROMPT },
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
        : 'Gemini colour-detection request failed',
      error,
    );
  }

  if (!response.ok) {
    classifyGeminiHttpStatus(response.status, 'Gemini colour detection');
  }

  try {
    return JSON.parse(await response.text());
  } catch {
    throw new PermanentProcessingError(
      'Gemini colour detection returned a non-JSON body',
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

function wrapDetectorError(error: unknown, fallback: string): Error {
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
      'Clothing item disappeared during colour detection persist',
    );
  }
  return wrapDetectorError(error, 'Failed to persist AI colour detection');
}

function extractColourTokens(value: unknown): unknown[] | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    return [value];
  }
  if (typeof value === 'object') {
    const raw = value as Record<string, unknown>;
    const nested =
      raw.detectedColours ?? raw.colours ?? raw.colors ?? raw.colour ?? raw.color;
    if (nested !== undefined) {
      return extractColourTokens(nested);
    }
  }
  return undefined;
}

function canonicalizeColour(value: unknown): ClothingColour | undefined {
  const normalized = normalizeToken(value);
  if (!normalized) {
    return undefined;
  }
  const aliased = COLOUR_ALIASES[normalized] ?? normalized;
  if ((CLOTHING_COLOURS as readonly string[]).includes(aliased)) {
    return aliased as ClothingColour;
  }
  return undefined;
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

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return normalized || undefined;
}

function asAiMetadata(value: unknown): GarmentAiMetadata | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return { ...(value as GarmentAiMetadata) };
}
