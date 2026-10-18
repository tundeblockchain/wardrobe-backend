import { MAX_RECOMMENDATIONS } from '../../src/functions/recommendations/strategy';
import {
  applyOutfitSuggestionCap,
  DEFAULT_OUTFIT_SUGGESTION_CAP,
  parseOutfitSuggestionCap,
  resolveOutfitSuggestionCap,
} from '../../src/shared/outfit-suggestion-cap';

describe('outfit suggestion cap (WARDROBE-229)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OUTFIT_SUGGESTION_CAP;
    delete process.env.OUTFIT_SUGGESTION_CAP_BASIC;
  });

  it('defaults to the current Premium per-response cap', () => {
    expect(DEFAULT_OUTFIT_SUGGESTION_CAP).toBe(8);
    expect(DEFAULT_OUTFIT_SUGGESTION_CAP).toBe(MAX_RECOMMENDATIONS);
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

  it('uses the shared Premium default when no env is set', () => {
    delete process.env.OUTFIT_SUGGESTION_CAP;
    delete process.env.OUTFIT_SUGGESTION_CAP_BASIC;
    expect(resolveOutfitSuggestionCap('PREMIUM')).toBe(8);
    expect(resolveOutfitSuggestionCap('BASIC')).toBe(8);
  });

  it('lets Basic fall back to the shared / Premium setting', () => {
    process.env.OUTFIT_SUGGESTION_CAP = '5';
    delete process.env.OUTFIT_SUGGESTION_CAP_BASIC;
    expect(resolveOutfitSuggestionCap('PREMIUM')).toBe(5);
    expect(resolveOutfitSuggestionCap('BASIC')).toBe(5);
  });

  it('applies a Basic override without inventing a default Basic value', () => {
    process.env.OUTFIT_SUGGESTION_CAP = '8';
    process.env.OUTFIT_SUGGESTION_CAP_BASIC = '2';
    expect(resolveOutfitSuggestionCap('BASIC')).toBe(2);
    expect(resolveOutfitSuggestionCap('PREMIUM')).toBe(8);
  });

  it('ignores an invalid Basic override and keeps Premium behaviour', () => {
    process.env.OUTFIT_SUGGESTION_CAP_BASIC = 'unlimited';
    expect(resolveOutfitSuggestionCap('BASIC')).toBe(8);
  });

  it('slices a recommendation list to the resolved cap', () => {
    const items = [1, 2, 3, 4, 5];
    expect(applyOutfitSuggestionCap(items, 2)).toEqual([1, 2]);
    expect(applyOutfitSuggestionCap(items, 8)).toEqual(items);
    expect(applyOutfitSuggestionCap(items, 0)).toEqual(items.slice(0, 8));
  });
});
