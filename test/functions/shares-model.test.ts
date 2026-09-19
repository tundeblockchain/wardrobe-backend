import {
  clothingPreviewImageKey,
  firstOutfitItemId,
  isShareExpired,
  isShareGone,
  isShareRevoked,
  isShareToken,
  outfitRenderPreviewKey,
  SHARE_TOKEN_PATTERN,
  sharePath,
  toShareDto,
  toShareItem,
  toSharePreviewDto,
} from '../../src/functions/shares/model';
import { newShareToken } from '../../src/shared/ids';
import { DynamoItem, SHARE_TTL_SECONDS } from '../../src/shared/types';

describe('share model (WARDROBE-126)', () => {
  it('issues shr_ tokens that match the public capability pattern', () => {
    const token = newShareToken();
    expect(token).toMatch(SHARE_TOKEN_PATTERN);
    expect(isShareToken(token)).toBe(true);
    expect(isShareToken('shr_short')).toBe(false);
    expect(isShareToken('item_abc')).toBe(false);
  });

  it('builds a SHARE row with GSI1 owner index and 30-day ttl', () => {
    const createdAt = '2026-09-19T12:00:00.000Z';
    const item = toShareItem(
      {
        userId: 'uid-1',
        wardrobeId: 'wd_1',
        resourceType: 'ITEM',
        itemId: 'item_1',
      },
      createdAt,
    );

    expect(item.entityType).toBe('SHARE');
    expect(item.PK).toBe(`SHARE#${item.token}`);
    expect(item.SK).toBe('SHARE');
    expect(item.GSI1PK).toBe('SHARE#USER#uid-1');
    expect(item.GSI1SK).toBe(`SHARE#${item.token}`);
    expect(item.itemId).toBe('item_1');
    expect(item).not.toHaveProperty('outfitId');
    expect(item.expiresAt).toBe(
      new Date(Date.parse(createdAt) + SHARE_TTL_SECONDS * 1000).toISOString(),
    );
    expect(item.ttl).toBe(
      Math.floor(Date.parse(createdAt) / 1000) + SHARE_TTL_SECONDS,
    );
  });

  it('soft-omits unused ids on Share and SharePreview DTOs', () => {
    const item = toShareItem({
      userId: 'uid-1',
      wardrobeId: 'wd_1',
      resourceType: 'OUTFIT',
      outfitId: 'outfit_1',
    });
    const dto = toShareDto(item);
    expect(dto.outfitId).toBe('outfit_1');
    expect(dto).not.toHaveProperty('itemId');
    expect(dto).not.toHaveProperty('userId');
    expect(dto.sharePath).toBe(sharePath(dto.token));
    expect(JSON.stringify(dto)).not.toContain('null');

    const preview = toSharePreviewDto(item, 'Friday Night');
    expect(preview).toEqual({
      resourceType: 'OUTFIT',
      title: 'Friday Night',
      expiresAt: String(item.expiresAt),
    });
    expect(preview).not.toHaveProperty('imageUrl');
    expect(JSON.stringify(preview)).not.toContain('null');
  });

  it('treats revoked and expired rows as gone', () => {
    const live: DynamoItem = {
      PK: 'SHARE#t',
      SK: 'SHARE',
      entityType: 'SHARE',
      userId: 'uid',
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      ttl: 4_000_000_000,
    };
    expect(isShareGone(live)).toBe(false);
    expect(isShareRevoked({ ...live, revokedAt: '2026-09-19T01:00:00.000Z' })).toBe(
      true,
    );
    expect(isShareExpired({ ...live, expiresAt: '2020-01-01T00:00:00.000Z' })).toBe(
      true,
    );
  });

  it('prefers processed item images and READY outfit renders', () => {
    expect(
      clothingPreviewImageKey({
        PK: 'a',
        SK: 'b',
        entityType: 'ITEM',
        userId: 'u',
        createdAt: 't',
        updatedAt: 't',
        processedKey: 'processed.png',
        originalKey: 'original.jpg',
      }),
    ).toBe('processed.png');

    expect(
      outfitRenderPreviewKey({
        PK: 'a',
        SK: 'b',
        entityType: 'OUTFIT',
        userId: 'u',
        createdAt: 't',
        updatedAt: 't',
        render: { status: 'READY', imageKey: 'render.png' },
      }),
    ).toBe('render.png');

    expect(
      outfitRenderPreviewKey({
        PK: 'a',
        SK: 'b',
        entityType: 'OUTFIT',
        userId: 'u',
        createdAt: 't',
        updatedAt: 't',
        render: { status: 'PENDING' },
      }),
    ).toBeUndefined();

    expect(
      firstOutfitItemId({
        PK: 'a',
        SK: 'b',
        entityType: 'OUTFIT',
        userId: 'u',
        createdAt: 't',
        updatedAt: 't',
        items: [{ itemId: 'item_1', slot: 'TOP' }],
      }),
    ).toBe('item_1');
  });
});
