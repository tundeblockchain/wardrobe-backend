import { MAX_RECOMMENDATIONS } from '../../src/functions/recommendations/strategy';
import {
  applyOutfitSuggestionCap,
  DEFAULT_OUTFIT_SUGGESTION_CAP,
  MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE,
  parseOutfitSuggestionCap,
  resolveGenerationOutfitSuggestionCap,
  resolveOutfitSuggestionCap,
  resolveResponseOutfitSuggestionCap,
} from '../../src/shared/outfit-suggestion-cap';

describe('outfit suggestion cap (WARDROBE-229 / WARDROBE-233)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OUTFIT_SUGGESTION_CAP;
    delete process.env.OUTFIT_SUGGESTION_CAP_BASIC;
  });

  it('defaults Premium to the current per-response cap', () => {
    expect(DEFAULT_OUTFIT_SUGGESTION_CAP).toBe(8);
    expect(DEFAULT_OUTFIT_SUGGESTION_CAP).toBe(MAX_RECOMMENDATIONS);
  });

  it('keeps an internal non-tier safety ceiling above the old product cap of 8', () => {
    expect(MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE).toBeGreaterThan(8);
    expect(MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE).toBe(256);
  });

  it('parses a positive integer and ignores invalid values', () => {
    expect(parseOutfitSuggestionCap('3')).toBe(3);
    expect(parseOutfitSuggestionCap(' 12 ')).toBe(12);
    expect(parseOutfitSuggestionCap(undefined)).toBeUndefined();
    expect(parseOutfitSuggestionCap('')).toBeUndefined();
    expect(parseOutfitSuggestionCap('  ')).toBeUndefined();
    expect(parseOutfitSuggestionCap('0')).toBeUndefined();
    expect(parseOutfitSuggestionCap('-1')).toBeUndefined();
    expect(parseOutfitSuggestionCap('1.5')).toBeUndefined();
    expect(parseOutfitSuggestionCap('nope')).toBeUndefined();
  });

  it('uses the Premium default when no env is set', () => {
    delete process.env.OUTFIT_SUGGESTION_CAP;
    expect(resolveOutfitSuggestionCap()).toBe(8);
    expect(resolveResponseOutfitSuggestionCap('PREMIUM')).toBe(8);
    expect(resolveResponseOutfitSuggestionCap('BASIC')).toBe(
      MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE,
    );
  });

  it('applies OUTFIT_SUGGESTION_CAP to Premium only', () => {
    process.env.OUTFIT_SUGGESTION_CAP = '5';
    expect(resolveOutfitSuggestionCap()).toBe(5);
    expect(resolveResponseOutfitSuggestionCap('PREMIUM')).toBe(5);
    expect(resolveResponseOutfitSuggestionCap('BASIC')).toBe(
      MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE,
    );
  });

  it('ignores leftover OUTFIT_SUGGESTION_CAP_BASIC so Basic is never capped by it', () => {
    process.env.OUTFIT_SUGGESTION_CAP = '8';
    process.env.OUTFIT_SUGGESTION_CAP_BASIC = '2';
    expect(resolveResponseOutfitSuggestionCap('BASIC')).toBe(
      MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE,
    );
    expect(resolveResponseOutfitSuggestionCap('PREMIUM')).toBe(8);
  });

  it('does not let an invalid Premium env change generation for either tier', () => {
    process.env.OUTFIT_SUGGESTION_CAP = 'unlimited';
    expect(resolveOutfitSuggestionCap()).toBe(8);
    expect(resolveGenerationOutfitSuggestionCap('PREMIUM')).toBe(8);
    expect(resolveGenerationOutfitSuggestionCap('BASIC')).toBe(
      MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE,
    );
  });

  it('slices a recommendation list to the resolved cap', () => {
    const items = [1, 2, 3, 4, 5];
    expect(applyOutfitSuggestionCap(items, 2)).toEqual([1, 2]);
    expect(applyOutfitSuggestionCap(items, 8)).toEqual(items);
    expect(applyOutfitSuggestionCap(items, 0)).toEqual(items.slice(0, 8));
    const many = Array.from({ length: 12 }, (_, i) => i);
    expect(applyOutfitSuggestionCap(many, MAX_OUTFIT_SUGGESTIONS_PER_RESPONSE)).toEqual(
      many,
    );
  });
});
