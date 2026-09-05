import { logger } from '../../shared/logger';
import { getSecretString, parseJsonObjectOrString } from '../../shared/secrets';
import { CLOTHING_CATEGORIES, OutfitRecommendation } from '../../shared/types';
import { extractRecommendations } from './http-recommender';
import {
  MAX_RECOMMENDATIONS,
  OutfitRecommender,
  RecommendableItem,
  createRuleBasedRecommender,
  hasWearableCore,
} from './strategy';

export const DEFAULT_OPENAI_CHAT_ENDPOINT =
  'https://api.openai.com/v1/chat/completions';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
export const DEFAULT_OPENAI_TIMEOUT_MS = 8_000;

export interface OpenAiRecommenderSecret {
  apiKey: string;
  model: string;
  endpoint: string;
}

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface OpenAiOutfitRecommenderOptions {
  fetchSecret?: () => Promise<OpenAiRecommenderSecret>;
  httpPost?: FetchLike;
  fallback?: OutfitRecommender;
}

const SYSTEM_PROMPT = [
  'You are a wardrobe stylist. Suggest wearable outfits from ONLY the supplied clothing items.',
  'Return JSON: {"recommendations":[{"name":"optional look name","items":[{"itemId":"...","slot":"TOP"}]}]}',
  `slot must be one of ${CLOTHING_CATEGORIES.join(', ')} and must match the item's slot.`,
  'Each outfit must be wearable: TOP+BOTTOM, or DRESS. Optionally add SHOES, OUTERWEAR, ACCESSORY, BAG.',
  'Use only itemId values from the input. Prefer colour-compatible combinations.',
  `Return at most ${MAX_RECOMMENDATIONS} distinct outfits.`,
  'Never invent items. Never persist outfits.',
].join(' ');

/**
 * OpenAI chat/text recommender (WARDROBE-28).
 * Tests inject fetchSecret / httpPost — never call a live model in CI.
 * Soft failures (HTTP, parse, secret, timeout) fall back to rule-based.
 */
export function createOpenAiOutfitRecommender(
  options: OpenAiOutfitRecommenderOptions = {},
): OutfitRecommender {
  const fetchSecret = options.fetchSecret ?? loadOpenAiRecommenderSecret;
  const httpPost = options.httpPost ?? defaultOpenAiFetch;
  const fallback = options.fallback ?? createRuleBasedRecommender();

  return {
    async recommend(items: RecommendableItem[]): Promise<OutfitRecommendation[]> {
      if (!hasWearableCore(items)) {
        return [];
      }

      try {
        const recommendations = await recommendWithOpenAi(
          items,
          fetchSecret,
          httpPost,
        );
        if (recommendations.length > 0) {
          return recommendations;
        }
        logger.warn(
          'OpenAI recommender returned no usable outfits; falling back to rule-based',
          { itemCount: items.length },
        );
        return fallback.recommend(items);
      } catch (error) {
        logger.warn('OpenAI recommender failed; falling back to rule-based', {
          itemCount: items.length,
          error: error instanceof Error ? error.message : 'unknown',
        });
        return fallback.recommend(items);
      }
    },
  };
}

export function parseOpenAiRecommenderSecret(
  secretString: string | undefined,
): OpenAiRecommenderSecret {
  const endpointFromEnv =
    process.env.AI_RECOMMENDER_ENDPOINT?.trim() ||
    process.env.OPENAI_API_BASE?.trim();
  const modelFromEnv = process.env.OPENAI_MODEL?.trim();

  if (!secretString?.trim()) {
    throw new Error('AI recommender secret is empty');
  }

  const parsed = parseJsonObjectOrString(secretString);
  if (typeof parsed === 'string') {
    return {
      apiKey: parsed,
      model: modelFromEnv || DEFAULT_OPENAI_MODEL,
      endpoint: endpointFromEnv || DEFAULT_OPENAI_CHAT_ENDPOINT,
    };
  }

  const apiKey = firstString(parsed, [
    'apiKey',
    'api_key',
    'key',
    'openaiApiKey',
    'OPENAI_API_KEY',
  ]);
  const model =
    firstString(parsed, ['model', 'openaiModel']) ||
    modelFromEnv ||
    DEFAULT_OPENAI_MODEL;
  const endpoint =
    firstString(parsed, ['endpoint', 'url', 'baseUrl']) ||
    endpointFromEnv ||
    DEFAULT_OPENAI_CHAT_ENDPOINT;

  if (!apiKey) {
    throw new Error('AI recommender secret is missing apiKey');
  }

  return { apiKey, model, endpoint };
}

export function extractOpenAiMessageContent(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') {
    return undefined;
  }

  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }

  const first = choices[0];
  if (first === null || typeof first !== 'object') {
    return undefined;
  }

  const message = (first as { message?: { content?: unknown } }).message;
  if (!message || typeof message !== 'object') {
    return undefined;
  }

  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts = content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (part && typeof part === 'object') {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .join('');
  return parts.trim() ? parts : undefined;
}

export function recommendationsFromOpenAiResponse(
  payload: unknown,
): OutfitRecommendation[] | undefined {
  const content = extractOpenAiMessageContent(payload);
  if (content === undefined) {
    return extractRecommendations(payload);
  }

  try {
    return extractRecommendations(parseJsonContent(content));
  } catch {
    return undefined;
  }
}

/**
 * Drop invented item IDs, force wardrobe slots, require a wearable core,
 * de-dupe, and cap at MAX_RECOMMENDATIONS.
 */
export function sanitizeRecommendations(
  recommendations: OutfitRecommendation[],
  wardrobeItems: RecommendableItem[],
): OutfitRecommendation[] {
  const byId = new Map(wardrobeItems.map((item) => [item.itemId, item]));
  const seen = new Set<string>();
  const sanitized: OutfitRecommendation[] = [];

  for (const recommendation of recommendations) {
    const items: OutfitRecommendation['items'] = [];
    const used = new Set<string>();

    for (const raw of recommendation.items) {
      const known = byId.get(raw.itemId);
      if (!known || used.has(known.itemId)) {
        continue;
      }
      items.push({ itemId: known.itemId, slot: known.slot });
      used.add(known.itemId);
    }

    if (!hasWearableCore(items)) {
      continue;
    }

    const signature = items
      .map((item) => `${item.slot}:${item.itemId}`)
      .sort()
      .join('|');
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);

    const next: OutfitRecommendation = { items };
    if (typeof recommendation.name === 'string' && recommendation.name.trim()) {
      next.name = recommendation.name.trim();
    }
    sanitized.push(next);
    if (sanitized.length >= MAX_RECOMMENDATIONS) {
      break;
    }
  }

  return sanitized;
}

async function recommendWithOpenAi(
  items: RecommendableItem[],
  fetchSecret: () => Promise<OpenAiRecommenderSecret>,
  httpPost: FetchLike,
): Promise<OutfitRecommendation[]> {
  const secret = await fetchSecret();
  const response = await httpPost(secret.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model: secret.model,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            items,
            maxRecommendations: MAX_RECOMMENDATIONS,
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI recommender HTTP ${response.status}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    throw new Error('OpenAI recommender returned a non-JSON body');
  }

  const extracted = recommendationsFromOpenAiResponse(parsed);
  if (!extracted) {
    throw new Error('OpenAI recommender response was not a recommendation list');
  }

  return sanitizeRecommendations(extracted, items);
}

async function loadOpenAiRecommenderSecret(): Promise<OpenAiRecommenderSecret> {
  const secretId = process.env.AI_RECOMMENDER_SECRET_ARN;
  if (!secretId) {
    throw new Error('AI_RECOMMENDER_SECRET_ARN is not configured');
  }
  return parseOpenAiRecommenderSecret(await getSecretString(secretId));
}

function parseJsonContent(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(trimmed);
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

function defaultOpenAiFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<{ ok: boolean; status: number; text(): Promise<string> }> {
  const timeoutMs = readTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  if (init?.signal) {
    if (init.signal.aborted) {
      controller.abort();
    } else {
      init.signal.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
    }
  }

  return fetch(url, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
  });
}

function readTimeoutMs(): number {
  const raw = process.env.OPENAI_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_OPENAI_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_OPENAI_TIMEOUT_MS;
}
