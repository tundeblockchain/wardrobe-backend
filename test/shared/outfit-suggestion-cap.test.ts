import { MAX_RECOMMENDATIONS } from '../../src/functions/recommendations/strategy';
import {
  applyOutfitSuggestionCap,
  MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE,
} from '../../src/shared/outfit-suggestion-cap';

describe('outfit suggestion bound (WARDROBE-233 / WARDROBE-235)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OUTFIT_SUGGESTION_CAP;
    delete process.env.OUTFIT_SUGGESTION_CAP_BASIC;
  });

  it('keeps an internal non-tier safety ceiling above the old product cap of 8', () => {
    expect(MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE).toBeGreaterThan(8);
    expect(MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE).toBe(256);
    expect(MAX_RECOMMENDATIONS).toBe(MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE);
  });

  it('ignores leftover OUTFIT_SUGGESTION_CAP and OUTFIT_SUGGESTION_CAP_BASIC', () => {
    process.env.OUTFIT_SUGGESTION_CAP = '3';
    process.env.OUTFIT_SUGGESTION_CAP_BASIC = '2';
    const items = Array.from({ length: 12 }, (_, i) => i);
    expect(applyOutfitSuggestionCap(items)).toEqual(items);
  });

  it('slices a recommendation list to the internal 256 bound', () => {
    const under = Array.from({ length: 12 }, (_, i) => i);
    expect(applyOutfitSuggestionCap(under)).toEqual(under);

    const over = Array.from(
      { length: MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE + 10 },
      (_, i) => i,
    );
    expect(applyOutfitSuggestionCap(over)).toHaveLength(
      MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE,
    );
    expect(applyOutfitSuggestionCap(over)).toEqual(
      over.slice(0, MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE),
    );
  });
});
