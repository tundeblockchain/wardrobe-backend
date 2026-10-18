import { SubscriptionTier } from './types';

/**
 * Per-response outfit-suggestion cap (WARDROBE-229).
 *
 * Premium today returns at most 8 looks (`MAX_RECOMMENDATIONS`).
 * Basic uses the same default unless an operator sets a Basic override.
 * The Basic value is intentionally not hardcoded — product can set it
 * via CDK context / env without a code change.
 *
 * CDK context / env (same pattern as support-contact rate limits):
 * - `outfitSuggestionCap` / `OUTFIT_SUGGESTION_CAP` — shared / Premium default
 * - `outfitSuggestionCapBasic` / `OUTFIT_SUGGESTION_CAP_BASIC` — Basic override
 */
export const DEFAULT_OUTFIT_SUGGESTION_CAP = 8;

export const OUTFIT_SUGGESTION_CAP_ENV = 'OUTFIT_SUGGESTION_CAP';
export const OUTFIT_SUGGESTION_CAP_BASIC_ENV = 'OUTFIT_SUGGESTION_CAP_BASIC';

export const OUTFIT_SUGGESTION_CAP_CONTEXT = 'outfitSuggestionCap';
export const OUTFIT_SUGGESTION_CAP_BASIC_CONTEXT = 'outfitSuggestionCapBasic';

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
 * Resolve the per-response cap for a paid tier.
 *
 * Basic falls back to the shared / Premium setting, then to today's
 * Premium default (8). Invalid or empty values are ignored.
 */
export function resolveOutfitSuggestionCap(
  tier: Extract<SubscriptionTier, 'BASIC' | 'PREMIUM'>,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const shared =
    parseOutfitSuggestionCap(env[OUTFIT_SUGGESTION_CAP_ENV]) ??
    DEFAULT_OUTFIT_SUGGESTION_CAP;
  if (tier === 'BASIC') {
    return parseOutfitSuggestionCap(env[OUTFIT_SUGGESTION_CAP_BASIC_ENV]) ?? shared;
  }
  return shared;
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
