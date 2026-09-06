import {
  buildGenericModelProfile,
  buildPersonalAiProfile,
  SYSTEM_AI_PROFILE_OWNER,
  toAiProfile,
} from '../../src/functions/ai-profiles/model';
import { tryOnSecretName, FUTURE_JOB_TYPES } from '../../src/functions/ai-profiles/hooks';

describe('AI profile model hooks (WARDROBE-43 / 45 / 47)', () => {
  it('builds a PERSONAL row under USER# without GSI1 attributes', () => {
    const item = buildPersonalAiProfile({
      userId: 'uid-1',
      aiProfileId: 'profile_abc',
      createdAt: '2026-09-06T08:00:00.000Z',
      updatedAt: '2026-09-06T08:00:00.000Z',
    });

    expect(item).toEqual({
      PK: 'USER#uid-1',
      SK: 'AIPROFILE#profile_abc',
      entityType: 'AIPROFILE',
      userId: 'uid-1',
      aiProfileId: 'profile_abc',
      type: 'PERSONAL',
      referenceImages: [],
      status: 'READY',
      createdAt: '2026-09-06T08:00:00.000Z',
      updatedAt: '2026-09-06T08:00:00.000Z',
    });
    expect(item).not.toHaveProperty('GSI1PK');
  });

  it('builds a GENERIC_MODEL catalog row with GSI1 keys for WARDROBE-45', () => {
    const item = buildGenericModelProfile({
      aiProfileId: 'profile_model',
      createdAt: '2026-09-06T07:00:00.000Z',
      updatedAt: '2026-09-06T07:00:00.000Z',
    });

    expect(item.PK).toBe('AIPROFILE#GENERIC_MODEL');
    expect(item.SK).toBe('AIPROFILE#profile_model');
    expect(item.GSI1PK).toBe('TYPE#GENERIC_MODEL');
    expect(item.GSI1SK).toBe('AIPROFILE#profile_model');
    expect(item.userId).toBe(SYSTEM_AI_PROFILE_OWNER);
    expect(item.type).toBe('GENERIC_MODEL');
  });

  it('maps Dynamo items to Flutter DTOs without PK/SK', () => {
    const dto = toAiProfile(
      buildPersonalAiProfile({
        userId: 'uid-1',
        aiProfileId: 'profile_abc',
        createdAt: '2026-09-06T08:00:00.000Z',
        updatedAt: '2026-09-06T08:00:00.000Z',
      }),
    );

    expect(dto).toEqual({
      aiProfileId: 'profile_abc',
      type: 'PERSONAL',
      referenceImages: [],
      status: 'READY',
      createdAt: '2026-09-06T08:00:00.000Z',
      updatedAt: '2026-09-06T08:00:00.000Z',
    });
    expect(dto).not.toHaveProperty('PK');
    expect(dto).not.toHaveProperty('userId');
  });

  it('reserves the WARDROBE-47 try-on secret id without creating it', () => {
    expect(tryOnSecretName('prod')).toBe('wardrobe/prod/gemini-try-on');
    expect(FUTURE_JOB_TYPES.processAiProfile).toBe('PROCESS_AI_PROFILE');
    expect(FUTURE_JOB_TYPES.renderOutfit).toBe('RENDER_OUTFIT');
  });
});
