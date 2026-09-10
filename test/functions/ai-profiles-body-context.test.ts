import {
  applyAiProfileBodyContext,
  formatAiProfileBodyContextForPrompt,
  isEmptyAiProfileBodyContext,
  pickAiProfileBodyContext,
  sameAiProfileBodyContext,
} from '../../src/functions/ai-profiles/body-context';
import {
  buildPersonalAiProfile,
  toAiProfile,
} from '../../src/functions/ai-profiles/model';

describe('AI profile body context (WARDROBE-80)', () => {
  const full = {
    heightCm: 170,
    weightKg: 65,
    bustCm: 90,
    hipsCm: 98,
    clothingSize: 'M',
    ageYears: 28,
    bodyType: 'AVERAGE',
    gender: 'FEMALE',
  };

  it('soft-omits empty and invalid stored values', () => {
    expect(pickAiProfileBodyContext({})).toEqual({});
    expect(
      pickAiProfileBodyContext({
        heightCm: '',
        weightKg: null,
        bustCm: '90',
        hipsCm: Number.NaN,
        clothingSize: '   ',
        ageYears: 28.5,
        bodyType: 1,
        gender: undefined,
      }),
    ).toEqual({});
    expect(isEmptyAiProfileBodyContext({})).toBe(true);
    expect(isEmptyAiProfileBodyContext(full)).toBe(false);
  });

  it('maps persisted fields onto the Flutter DTO and omits empties', () => {
    const withBody = toAiProfile(
      buildPersonalAiProfile({
        userId: 'uid-1',
        aiProfileId: 'profile_abc',
        body: full,
        createdAt: '2026-09-06T08:00:00.000Z',
        updatedAt: '2026-09-06T08:00:00.000Z',
      }),
    );
    expect(withBody).toMatchObject(full);
    expect(withBody.referenceImages).toEqual([]);

    const empty = toAiProfile(
      buildPersonalAiProfile({
        userId: 'uid-1',
        aiProfileId: 'profile_abc',
        createdAt: '2026-09-06T08:00:00.000Z',
        updatedAt: '2026-09-06T08:00:00.000Z',
      }),
    );
    expect(empty).not.toHaveProperty('heightCm');
    expect(empty).not.toHaveProperty('weightKg');
    expect(empty).not.toHaveProperty('clothingSize');
    expect(empty).not.toHaveProperty('gender');
  });

  it('formats only present fields for the try-on prompt', () => {
    expect(formatAiProfileBodyContextForPrompt(undefined)).toEqual([]);
    expect(formatAiProfileBodyContextForPrompt({})).toEqual([]);

    const lines = formatAiProfileBodyContextForPrompt({
      heightCm: 175,
      clothingSize: 'M',
      gender: 'FEMALE',
    });
    expect(lines[0]).toContain('Person body context');
    expect(lines).toContain('- height: 175 cm');
    expect(lines).toContain('- clothing size: M');
    expect(lines).toContain('- gender: FEMALE');
    expect(lines.join('\n')).not.toContain('weight');
    expect(lines.join('\n')).not.toContain('bust');
    expect(lines.join('\n')).not.toContain('age');
  });

  it('compares body fields for catalog seed idempotency', () => {
    const left = applyAiProfileBodyContext({ id: 'a' }, { heightCm: 175 });
    const right = applyAiProfileBodyContext({ id: 'b' }, { heightCm: 175 });
    expect(sameAiProfileBodyContext(left, right)).toBe(true);
    expect(sameAiProfileBodyContext(left, { heightCm: 180 })).toBe(false);
    expect(sameAiProfileBodyContext({}, {})).toBe(true);
  });
});
