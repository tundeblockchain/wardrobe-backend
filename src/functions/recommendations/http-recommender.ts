import { getSecretString, parseJsonObjectOrString } from '../../shared/secrets';
import { OutfitRecommendation } from '../../shared/types';
import {
  OutfitRecommender,
  RecommendableItem,
} from './strategy';

export interface RecommenderSecret {
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

export interface HttpOutfitRecommenderOptions {
  fetchSecret?: () => Promise<RecommenderSecret>;
  httpPost?: FetchLike;
}

/**
 * Optional vendor hook. Default recommendations stay rule-based.
 * Tests inject fetchSecret / httpPost — never call a live model in CI.
 */
export function createHttpOutfitRecommender(
  options: HttpOutfitRecommenderOptions = {},
): OutfitRecommender {
  const fetchSecret = options.fetchSecret ?? loadRecommenderSecret;
  const httpPost = options.httpPost ?? defaultFetch;

  return {
    async recommend(items: RecommendableItem[]): Promise<OutfitRecommendation[]> {
      const secret = await fetchSecret();
      const response = await httpPost(secret.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ items }),
      });

      if (!response.ok) {
        throw new Error(`Outfit recommender HTTP ${response.status}`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(await response.text());
      } catch {
        throw new Error('Outfit recommender returned a non-JSON body');
      }

      const recommendations = extractRecommendations(parsed);
      if (!recommendations) {
        throw new Error('Outfit recommender response was not a recommendation list');
      }
      return recommendations;
    },
  };
}

export function parseRecommenderSecret(
  secretString: string | undefined,
): RecommenderSecret {
  const endpointFromEnv = process.env.AI_RECOMMENDER_ENDPOINT?.trim();

  if (!secretString?.trim()) {
    throw new Error('AI recommender secret is empty');
  }

  const parsed = parseJsonObjectOrString(secretString);
  if (typeof parsed === 'string') {
    if (!endpointFromEnv) {
      throw new Error(
        'AI_RECOMMENDER_ENDPOINT is required when the secret is a raw API key',
      );
    }
    return { apiKey: parsed, endpoint: endpointFromEnv };
  }

  const apiKey = firstString(parsed, ['apiKey', 'api_key', 'key']);
  const endpoint =
    firstString(parsed, ['endpoint', 'url']) || endpointFromEnv || '';

  if (!apiKey) {
    throw new Error('AI recommender secret is missing apiKey');
  }
  if (!endpoint) {
    throw new Error('AI recommender secret is missing endpoint');
  }

  return { apiKey, endpoint };
}

export function extractRecommendations(
  value: unknown,
): OutfitRecommendation[] | undefined {
  if (Array.isArray(value)) {
    return toRecommendationList(value);
  }
  if (value !== null && typeof value === 'object') {
    const raw = value as { recommendations?: unknown };
    if (Array.isArray(raw.recommendations)) {
      return toRecommendationList(raw.recommendations);
    }
  }
  return undefined;
}

async function loadRecommenderSecret(): Promise<RecommenderSecret> {
  const secretId = process.env.AI_RECOMMENDER_SECRET_ARN;
  if (!secretId) {
    throw new Error('AI_RECOMMENDER_SECRET_ARN is not configured');
  }
  return parseRecommenderSecret(await getSecretString(secretId));
}

function toRecommendationList(value: unknown[]): OutfitRecommendation[] | undefined {
  const recommendations: OutfitRecommendation[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return undefined;
    }
    const raw = entry as { name?: unknown; items?: unknown };
    if (!Array.isArray(raw.items)) {
      return undefined;
    }
    const items = raw.items.map((item) => {
      const row = (item ?? {}) as { itemId?: unknown; slot?: unknown };
      return {
        itemId: String(row.itemId ?? ''),
        slot: String(row.slot ?? '') as OutfitRecommendation['items'][number]['slot'],
      };
    });
    if (items.some((item) => !item.itemId || !item.slot)) {
      return undefined;
    }
    const recommendation: OutfitRecommendation = { items };
    if (typeof raw.name === 'string' && raw.name.trim()) {
      recommendation.name = raw.name.trim();
    }
    recommendations.push(recommendation);
  }
  return recommendations;
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
