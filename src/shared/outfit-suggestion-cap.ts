/**
 * Per-response outfit-suggestion bound (WARDROBE-229 / WARDROBE-233 /
 * WARDROBE-235).
 *
 * Basic and Premium are not product-capped. Free is not served
 * (`403 ENTITLEMENT_AI_REQUIRED`). There is no per-day or per-month
 * usage counter.
 *
 * Leftover `outfitSuggestionCap` / `OUTFIT_SUGGESTION_CAP` and
 * `outfitSuggestionCapBasic` / `OUTFIT_SUGGESTION_CAP_BASIC` values
 * are ignored if still present in CDK context or the environment.
 *
 * `MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE` is an internal safety ceiling
 * so a single Lambda response cannot grow unbounded. It is not
 * configurable and not an entitlement.
 */

/**
 * Hard ceiling for one GET /recommendations response. Not an entitlement
 * or product cap. Rule-based generation is already bounded by
 * `MAX_ITEMS_PER_SLOT`; this exists for OpenAI / HTTP vendor lists.
 */
export const MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE = 256;

/**
 * Slice a recommendation list to the internal safety ceiling.
 * Leftover `OUTFIT_SUGGESTION_CAP` / `_BASIC` env values are not read.
 */
export function applyOutfitSuggestionCap<T>(recommendations: T[]): T[] {
  return recommendations.slice(0, MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE);
}
