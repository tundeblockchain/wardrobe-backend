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
import type { ProcessingContext } from './pipeline';

export const MAX_DETECTED_COLOURS = 8;

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

const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedSecret: ColourDetectorSecret | undefined;
let cachedSecretAt = 0;

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
 * WARDROBE-20: detect colours (and optionally refine category) and persist
 * under `ai` only. User-set `category` / `subcategory` / `colours` are
 * never overwritten.
 */
export async function detectColourAndCategory(
  context: ProcessingContext,
  deps: DetectColourAndCategoryDeps = {},
): Promise<void> {
  const imageKey = resolveColourDetectionImageKey(context);
  const detector = deps.detector ?? createHttpColourDetector();
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

export function resetColourDetectorSecretCache(): void {
  cachedSecret = undefined;
  cachedSecretAt = 0;
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

function asAiMetadata(value: unknown): GarmentAiMetadata | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return { ...(value as GarmentAiMetadata) };
}
