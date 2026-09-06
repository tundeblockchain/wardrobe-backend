import {
  GENERIC_MODEL_CATALOG_CREATED_AT,
  GENERIC_MODEL_CATALOG_VERSION,
  GENERIC_MODEL_IMAGE_PREFIX,
  GENERIC_MODEL_SPECS,
  genericModelCatalog,
  genericModelIds,
  genericModelImageKey,
} from '../../src/functions/ai-profiles/catalog';
import { buildGenericModelProfile, toAiProfile } from '../../src/functions/ai-profiles/model';

describe('GENERIC_MODEL catalog (WARDROBE-45)', () => {
  it('defines 2–4 stable READY models with shared placeholder keys', () => {
    expect(GENERIC_MODEL_SPECS.length).toBeGreaterThanOrEqual(2);
    expect(GENERIC_MODEL_SPECS.length).toBeLessThanOrEqual(4);
    expect(GENERIC_MODEL_CATALOG_VERSION).toMatch(/^\d+$/);
    expect(GENERIC_MODEL_CATALOG_CREATED_AT).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );

    const ids = genericModelIds();
    expect(new Set(ids).size).toBe(ids.length);

    for (const spec of GENERIC_MODEL_SPECS) {
      expect(spec.aiProfileId).toMatch(/^profile_generic_\d{2}$/);
      expect(spec.label.trim().length).toBeGreaterThan(0);
      expect(spec.slug).toMatch(/^[a-z0-9-]+$/);
      expect(genericModelImageKey(spec.slug, spec.fileName)).toBe(
        `${GENERIC_MODEL_IMAGE_PREFIX}${spec.slug}/${spec.fileName}`,
      );
    }
  });

  it('builds Flutter-ready catalog rows with GSI1 keys and no secrets', () => {
    const catalog = genericModelCatalog();
    expect(catalog).toHaveLength(4);

    for (const entry of catalog) {
      expect(entry.status).toBe('READY');
      expect(entry.referenceImages).toEqual([
        expect.stringMatching(/^shared\/ai-profiles\/generic\/[a-z0-9-]+\/front\.jpg$/),
      ]);

      const item = buildGenericModelProfile({
        aiProfileId: entry.aiProfileId,
        referenceImages: entry.referenceImages,
        status: entry.status,
        label: entry.label,
        createdAt: GENERIC_MODEL_CATALOG_CREATED_AT,
        updatedAt: GENERIC_MODEL_CATALOG_CREATED_AT,
      });

      expect(item.PK).toBe('AIPROFILE#GENERIC_MODEL');
      expect(item.SK).toBe(`AIPROFILE#${entry.aiProfileId}`);
      expect(item.GSI1PK).toBe('TYPE#GENERIC_MODEL');
      expect(item.GSI1SK).toBe(`AIPROFILE#${entry.aiProfileId}`);
      expect(item.status).toBe('READY');
      expect(item.label).toBe(entry.label);

      const dto = toAiProfile(item);
      expect(dto).toEqual({
        aiProfileId: entry.aiProfileId,
        type: 'GENERIC_MODEL',
        label: entry.label,
        referenceImages: entry.referenceImages,
        status: 'READY',
        createdAt: GENERIC_MODEL_CATALOG_CREATED_AT,
        updatedAt: GENERIC_MODEL_CATALOG_CREATED_AT,
      });
      expect(dto).not.toHaveProperty('userId');
      expect(dto).not.toHaveProperty('PK');
    }

    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(serialized).not.toMatch(/AIza[0-9A-Za-z_-]{35}/);
    expect(serialized).not.toContain('apiKey');
  });

  it('rejects unsafe slug segments', () => {
    expect(() => genericModelImageKey('../secret', 'front.jpg')).toThrow(
      /not a valid key segment/,
    );
    expect(() => genericModelImageKey('alex', 'a/b.jpg')).toThrow(
      /not a valid key segment/,
    );
  });
});
