import { AiProfileBodyContext } from '../../shared/types';

/**
 * Stable GENERIC_MODEL catalog (WARDROBE-45 / WARDROBE-80).
 *
 * Flutter caches these `aiProfileId`s. Do not rename IDs once shipped.
 * Reference keys are documented placeholders under a shared S3 prefix —
 * Tunde uploads real full-body photos after deploy. Never commit image
 * binaries or API keys.
 *
 * Body/context defaults (cm / kg / years) ground Gemini try-on when a
 * picker model is used. They are optional on PERSONAL profiles.
 */

export const GENERIC_MODEL_IMAGE_PREFIX = 'shared/ai-profiles/generic/';

/** Fixed createdAt for first insert so Flutter timestamps stay stable. */
export const GENERIC_MODEL_CATALOG_CREATED_AT = '2026-09-06T00:00:00.000Z';

/** Bump when the catalog set changes so the CDK custom resource re-runs. */
export const GENERIC_MODEL_CATALOG_VERSION = '3';

/** Canonical frontal reference for seeded GENERIC_MODEL profiles (WARDROBE-72). */
export const GENERIC_MODEL_FRONTAL_FILE = 'front.png';

export interface GenericModelSpec {
  aiProfileId: string;
  label: string;
  slug: string;
  fileName: string;
  /** Seeded try-on body context. Soft-omit a field by leaving it unset. */
  body?: AiProfileBodyContext;
}

export const GENERIC_MODEL_SPECS: readonly GenericModelSpec[] = [
  {
    aiProfileId: 'profile_generic_01',
    label: 'Alex',
    slug: 'alex',
    fileName: GENERIC_MODEL_FRONTAL_FILE,
    body: {
      heightCm: 175,
      weightKg: 70,
      clothingSize: 'M',
      ageYears: 28,
      bodyType: 'AVERAGE',
    },
  },
  {
    aiProfileId: 'profile_generic_02',
    label: 'Jordan',
    slug: 'jordan',
    fileName: GENERIC_MODEL_FRONTAL_FILE,
    body: {
      heightCm: 168,
      weightKg: 62,
      clothingSize: 'S',
      ageYears: 26,
      bodyType: 'SLIM',
    },
  },
  {
    aiProfileId: 'profile_generic_03',
    label: 'Sam',
    slug: 'sam',
    fileName: GENERIC_MODEL_FRONTAL_FILE,
    body: {
      heightCm: 180,
      weightKg: 78,
      clothingSize: 'L',
      ageYears: 30,
      bodyType: 'ATHLETIC',
    },
  },
  {
    aiProfileId: 'profile_generic_04',
    label: 'Riley',
    slug: 'riley',
    fileName: GENERIC_MODEL_FRONTAL_FILE,
    body: {
      heightCm: 162,
      weightKg: 58,
      clothingSize: 'S',
      ageYears: 24,
      bodyType: 'PETITE',
    },
  },
];

function isSafeSlug(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('..') &&
    !value.includes('\0')
  );
}

export function genericModelImageKey(
  slug: string,
  fileName = GENERIC_MODEL_FRONTAL_FILE,
): string {
  if (!isSafeSlug(slug) || !isSafeSlug(fileName)) {
    throw new Error('generic model image slug/fileName is not a valid key segment.');
  }
  return `${GENERIC_MODEL_IMAGE_PREFIX}${slug}/${fileName}`;
}

export interface GenericModelCatalogEntry {
  aiProfileId: string;
  label: string;
  referenceImages: string[];
  status: 'READY';
  body?: AiProfileBodyContext;
}

export function genericModelCatalog(): GenericModelCatalogEntry[] {
  return GENERIC_MODEL_SPECS.map((spec) => ({
    aiProfileId: spec.aiProfileId,
    label: spec.label,
    referenceImages: [genericModelImageKey(spec.slug, spec.fileName)],
    status: 'READY' as const,
    ...(spec.body ? { body: spec.body } : {}),
  }));
}

export function genericModelIds(): string[] {
  return GENERIC_MODEL_SPECS.map((spec) => spec.aiProfileId);
}
