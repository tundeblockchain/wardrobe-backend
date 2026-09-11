import { GetObjectCommand } from '@aws-sdk/client-s3';

const mockGetSignedUrl = jest.fn();

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({})),
  GetObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'GetObject',
    input,
  })),
  PutObjectCommand: jest.fn(),
  ListObjectsV2Command: jest.fn(),
  DeleteObjectsCommand: jest.fn(),
}));

import {
  appendSuccessfulRender,
  newestFirstHistory,
  seedHistoryFromCurrentRender,
  toOutfitRender,
  toRenderHistory,
  withSignedRenderHistory,
} from '../../src/functions/outfits/render';

const OLD_KEY = 'users/uid/outfits/outfit_1/render.png';
const NEW_KEY = 'users/uid/outfits/outfit_1/renders/rend_new1abcd.png';

describe('outfit render history helpers (WARDROBE-85)', () => {
  const originalBucket = process.env.MEDIA_BUCKET_NAME;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MEDIA_BUCKET_NAME = 'wardrobe-media-test';
    mockGetSignedUrl.mockImplementation(
      async (_client: unknown, command: { input?: { Key?: string } }) =>
        `https://signed.example/${command.input?.Key ?? 'missing'}`,
    );
  });

  afterEach(() => {
    if (originalBucket === undefined) {
      delete process.env.MEDIA_BUCKET_NAME;
    } else {
      process.env.MEDIA_BUCKET_NAME = originalBucket;
    }
  });

  it('parses stored history and drops invalid / duplicate keys', () => {
    expect(
      toRenderHistory([
        {
          imageKey: OLD_KEY,
          createdAt: '2026-09-10T08:00:00.000Z',
          aiProfileId: 'profile_generic_01',
        },
        { imageKey: '   ', createdAt: '2026-09-10T09:00:00.000Z' },
        {
          imageKey: OLD_KEY,
          createdAt: '2026-09-10T10:00:00.000Z',
          aiProfileId: 'profile_generic_01',
        },
        {
          imageKey: NEW_KEY,
          createdAt: '2026-09-11T08:00:00.000Z',
          aiProfileId: 'profile_generic_01',
        },
      ]),
    ).toEqual([
      {
        imageKey: OLD_KEY,
        createdAt: '2026-09-10T08:00:00.000Z',
        aiProfileId: 'profile_generic_01',
      },
      {
        imageKey: NEW_KEY,
        createdAt: '2026-09-11T08:00:00.000Z',
        aiProfileId: 'profile_generic_01',
      },
    ]);
  });

  it('appends a successful try-on without overwriting earlier keys', () => {
    const first = appendSuccessfulRender([], {
      imageKey: OLD_KEY,
      createdAt: '2026-09-10T08:00:00.000Z',
      aiProfileId: 'profile_a',
    });
    const second = appendSuccessfulRender(first, {
      imageKey: NEW_KEY,
      createdAt: '2026-09-11T08:00:00.000Z',
      aiProfileId: 'profile_b',
    });
    const replay = appendSuccessfulRender(second, {
      imageKey: NEW_KEY,
      createdAt: '2026-09-11T09:00:00.000Z',
      aiProfileId: 'profile_b',
    });

    expect(second).toHaveLength(2);
    expect(second.map((entry) => entry.imageKey)).toEqual([OLD_KEY, NEW_KEY]);
    expect(replay).toEqual(second);
  });

  it('seeds a legacy READY render.png into history once', () => {
    const render = toOutfitRender({
      status: 'READY',
      aiProfileId: 'profile_generic_01',
      imageKey: OLD_KEY,
    });
    const seeded = seedHistoryFromCurrentRender(
      [],
      render,
      '2026-09-10T08:00:00.000Z',
    );
    const again = seedHistoryFromCurrentRender(
      seeded,
      render,
      '2026-09-11T00:00:00.000Z',
    );

    expect(seeded).toEqual([
      {
        imageKey: OLD_KEY,
        createdAt: '2026-09-10T08:00:00.000Z',
        aiProfileId: 'profile_generic_01',
      },
    ]);
    expect(again).toEqual(seeded);
  });

  it('returns newest-first signed URLs and soft-omits a failed presign', async () => {
    mockGetSignedUrl.mockImplementation(
      async (_client: unknown, command: { input?: { Key?: string } }) => {
        const key = command.input?.Key ?? '';
        if (key === OLD_KEY) {
          throw new Error('presign failed');
        }
        return `https://signed.example/${key}`;
      },
    );

    const signed = await withSignedRenderHistory([
      {
        imageKey: OLD_KEY,
        createdAt: '2026-09-10T08:00:00.000Z',
        aiProfileId: 'profile_generic_01',
      },
      {
        imageKey: NEW_KEY,
        createdAt: '2026-09-11T08:00:00.000Z',
        aiProfileId: 'profile_generic_01',
      },
    ]);

    expect(newestFirstHistory([
      { imageKey: OLD_KEY, createdAt: 'a', aiProfileId: 'p' },
      { imageKey: NEW_KEY, createdAt: 'b', aiProfileId: 'p' },
    ]).map((entry) => entry.imageKey)).toEqual([NEW_KEY, OLD_KEY]);

    expect(signed.renderHistory).toEqual([
      {
        imageKey: NEW_KEY,
        createdAt: '2026-09-11T08:00:00.000Z',
        aiProfileId: 'profile_generic_01',
        imageUrl: `https://signed.example/${NEW_KEY}`,
      },
      {
        imageKey: OLD_KEY,
        createdAt: '2026-09-10T08:00:00.000Z',
        aiProfileId: 'profile_generic_01',
      },
    ]);
    expect(signed.renderImageUrls).toEqual([`https://signed.example/${NEW_KEY}`]);
    expect(GetObjectCommand).toHaveBeenCalled();
  });

  it('omits renderImageUrls when every presign fails', async () => {
    mockGetSignedUrl.mockRejectedValue(new Error('presign failed'));

    const signed = await withSignedRenderHistory([
      {
        imageKey: NEW_KEY,
        createdAt: '2026-09-11T08:00:00.000Z',
        aiProfileId: 'profile_generic_01',
      },
    ]);

    expect(signed.renderHistory).toEqual([
      {
        imageKey: NEW_KEY,
        createdAt: '2026-09-11T08:00:00.000Z',
        aiProfileId: 'profile_generic_01',
      },
    ]);
    expect(signed.renderImageUrls).toBeUndefined();
  });
});
