import { SubscriptionTier } from './types';

/**
 * Per-response outfit-suggestion limits (WARDROBE-229 / WARDROBE-233).
 *
 * Premium today returns at most 8 looks (`MAX_RECOMMENDATIONS`). That
 * product cap is configurable via CDK context / env:
 * - `outfitSuggestionCap` / `OUTFIT_SUGGESTION_CAP` — Premium only
 *
 * Basic is not product-capped (WARDROBE-233). There is no per-day or
 * per-month usage counter. The Basic-only override
 * (`outfitSuggestionCapBasic` / `OUTFIT_SUGGESTION_CAP_BASIC`) is removed.
 *
 * `MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE` is an internal safety ceiling so a
 * single Lambda response cannot grow unbounded. It is not configurable and
 * not tier-specific. Premium still uses the product cap of 8, which is
 * lower than this ceiling.
 */
export const DEFAULT_OUTFIT_SUGGESTION_CAP = 8;

/**
 * Hard ceiling for one GET /recommendations response. Not an entitlement
 * or product cap. Rule-based generation is already bounded by
 * `MAX_ITEMS_PER_SLOT`; this exists for OpenAI / HTTP vendor lists.
 */
export const MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE = 256;

export const OUTFIT_SUGGESTION_CAP_ENV = 'OUTFIT_SUGGESTION_CAP';

export const OUTFIT_SUGGESTION_CAP_CONTEXT = 'outfitSuggestionCap';

export function parseOutfitSuggestionCap(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return undefined;
  }
  return parsed;
}

/**
 * Resolve the Premium per-response product cap.
 *
 * Invalid or empty values fall back to today's Premium default (8).
 * Basic must not call this — Basic is not product-capped.
 */
export function resolveOutfitSuggestionCap(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (
    parseOutfitSuggestionCap(env[OUTFIT_SUGGESTION_CAP_ENV]) ??
    DEFAULT_OUTFIT_SUGGESTION_CAP
  );
}

/**
 * Response-side slice for a paid tier.
 *
 * Premium: `OUTFIT_SUGGESTION_CAP` (default 8).
 * Basic: internal safety ceiling only.
 */
export function resolveResponseOutfitSuggestionCap(
  tier: Extract<SubscriptionTier, 'BASIC' | 'PREMIUM'>,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (tier === 'BASIC') {
    return MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE;
  }
  return resolveOutfitSuggestionCap(env);
}

/**
 * How many looks the recommender may generate.
 *
 * Premium keeps today's `MAX_RECOMMENDATIONS` / 8 (not the env override —
 * the handler still slices Premium to `OUTFIT_SUGGESTION_CAP` after).
 * Basic uses the internal safety ceiling so openai/rules can return more
 * than 8.
 */
export function resolveGenerationOutfitSuggestionCap(
  tier: Extract<SubscriptionTier, 'BASIC' | 'PREMIUM'>,
): number {
  if (tier === 'BASIC') {
    return MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE;
  }
  return DEFAULT_OUTFIT_SUGGESTION_CAP;
}

export function applyOutfitSuggestionCap<T>(
  recommendations: T[],
  cap: number,
): T[] {
  if (!Number.isInteger(cap) || cap < 1) {
    return recommendations.slice(0, DEFAULT_OUTFIT_SUGGESTION_CAP);
  }
  return recommendations.slice(0, cap);
}
