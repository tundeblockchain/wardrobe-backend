const mockGetSignedUrl = jest.fn();

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({})),
  GetObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    input,
  })),
}));

import {
  buildGenericModelProfile,
  buildPersonalAiProfile,
  frontalReferenceImageKey,
  mergeReferenceImages,
  SYSTEM_AI_PROFILE_OWNER,
  toAiProfile,
  withSignedReferenceImageUrls,
} from '../../src/functions/ai-profiles/model';
import {
  buildProcessAiProfileJob,
  buildRenderOutfitJob,
  FUTURE_JOB_TYPES,
  statusAfterReferenceImagesAttached,
  tryOnSecretName,
} from '../../src/functions/ai-profiles/hooks';

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
      label: 'Alex',
      createdAt: '2026-09-06T07:00:00.000Z',
      updatedAt: '2026-09-06T07:00:00.000Z',
    });

    expect(item.PK).toBe('AIPROFILE#GENERIC_MODEL');
    expect(item.SK).toBe('AIPROFILE#profile_model');
    expect(item.GSI1PK).toBe('TYPE#GENERIC_MODEL');
    expect(item.GSI1SK).toBe('AIPROFILE#profile_model');
    expect(item.userId).toBe(SYSTEM_AI_PROFILE_OWNER);
    expect(item.type).toBe('GENERIC_MODEL');
    expect(item.label).toBe('Alex');
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

  it('documents the WARDROBE-47 try-on secret id and RENDER_OUTFIT job', () => {
    expect(tryOnSecretName('prod')).toBe('wardrobe/prod/gemini-try-on');
    expect(FUTURE_JOB_TYPES.processAiProfile).toBe('PROCESS_AI_PROFILE');
    expect(FUTURE_JOB_TYPES.renderOutfit).toBe('RENDER_OUTFIT');
    expect(
      buildRenderOutfitJob('uid-1', 'wd_1', 'outfit_1', 'profile_generic_01'),
    ).toEqual({
      jobType: 'RENDER_OUTFIT',
      userId: 'uid-1',
      wardrobeId: 'wd_1',
      outfitId: 'outfit_1',
      aiProfileId: 'profile_generic_01',
    });
  });

  it('keeps attach status READY and documents the PROCESS_AI_PROFILE job hook', () => {
    expect(statusAfterReferenceImagesAttached()).toBe('READY');
    expect(buildProcessAiProfileJob('uid-1', 'profile_abc')).toEqual({
      jobType: 'PROCESS_AI_PROFILE',
      userId: 'uid-1',
      aiProfileId: 'profile_abc',
    });
  });

  it('appends unique reference images and rejects more than 10', () => {
    expect(mergeReferenceImages(['a.jpg'], ['a.jpg', 'b.jpg'])).toEqual([
      'a.jpg',
      'b.jpg',
    ]);
    const eleven = Array.from({ length: 11 }, (_, i) => `k-${i}.jpg`);
    expect(() => mergeReferenceImages([], eleven)).toThrow();
  });

  it('picks a front.* filename as the frontal key, else the first key', () => {
    expect(
      frontalReferenceImageKey([
        'users/u/ai-profiles/p/side.jpg',
        'users/u/ai-profiles/p/front.jpg',
      ]),
    ).toBe('users/u/ai-profiles/p/front.jpg');
    expect(
      frontalReferenceImageKey([
        'shared/ai-profiles/generic/alex/side.jpg',
        'shared/ai-profiles/generic/alex/front.png',
      ]),
    ).toBe('shared/ai-profiles/generic/alex/front.png');
    expect(frontalReferenceImageKey(['users/u/a.jpg', 'users/u/b.jpg'])).toBe(
      'users/u/a.jpg',
    );
    expect(frontalReferenceImageKey([])).toBeUndefined();
  });

  it('adds frontImageUrl and omits it when presign fails', async () => {
    const front = 'shared/ai-profiles/generic/alex/front.png';
    const side = 'shared/ai-profiles/generic/alex/side.jpg';
    const base = toAiProfile(
      buildGenericModelProfile({
        aiProfileId: 'profile_generic_01',
        label: 'Alex',
        referenceImages: [side, front],
        createdAt: '2026-09-06T00:00:00.000Z',
        updatedAt: '2026-09-06T00:00:00.000Z',
      }),
    );

    process.env.MEDIA_BUCKET_NAME = 'wardrobe-media-test';
    mockGetSignedUrl.mockImplementation(
      async (_client: unknown, command: { input?: { Key?: string } }) =>
        `https://signed.example/${command.input?.Key ?? ''}`,
    );

    await expect(withSignedReferenceImageUrls(base)).resolves.toEqual({
      ...base,
      frontImageUrl: `https://signed.example/${front}`,
      referenceImageUrls: {
        [side]: `https://signed.example/${side}`,
      },
    });

    mockGetSignedUrl.mockRejectedValue(new Error('presign unavailable'));
    const omitted = await withSignedReferenceImageUrls(base);
    expect(omitted).toEqual(base);
    expect(omitted).not.toHaveProperty('frontImageUrl');
    expect(omitted).not.toHaveProperty('referenceImageUrls');

    delete process.env.MEDIA_BUCKET_NAME;
  });
});
