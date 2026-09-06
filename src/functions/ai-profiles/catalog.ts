/**
 * Stable GENERIC_MODEL catalog (WARDROBE-45).
 *
 * Flutter caches these `aiProfileId`s. Do not rename IDs once shipped.
 * Reference keys are documented placeholders under a shared S3 prefix —
 * Tunde uploads real full-body photos after deploy. Never commit image
 * binaries or API keys.
 */

export const GENERIC_MODEL_IMAGE_PREFIX = 'shared/ai-profiles/generic/';

/** Fixed createdAt for first insert so Flutter timestamps stay stable. */
export const GENERIC_MODEL_CATALOG_CREATED_AT = '2026-09-06T00:00:00.000Z';

/** Bump when the catalog set changes so the CDK custom resource re-runs. */
export const GENERIC_MODEL_CATALOG_VERSION = '1';

export interface GenericModelSpec {
  aiProfileId: string;
  label: string;
  slug: string;
  fileName: string;
}

export const GENERIC_MODEL_SPECS: readonly GenericModelSpec[] = [
  {
    aiProfileId: 'profile_generic_01',
    label: 'Alex',
    slug: 'alex',
    fileName: 'front.jpg',
  },
  {
    aiProfileId: 'profile_generic_02',
    label: 'Jordan',
    slug: 'jordan',
    fileName: 'front.jpg',
  },
  {
    aiProfileId: 'profile_generic_03',
    label: 'Sam',
    slug: 'sam',
    fileName: 'front.jpg',
  },
  {
    aiProfileId: 'profile_generic_04',
    label: 'Riley',
    slug: 'riley',
    fileName: 'front.jpg',
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
  fileName = 'front.jpg',
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
}

export function genericModelCatalog(): GenericModelCatalogEntry[] {
  return GENERIC_MODEL_SPECS.map((spec) => ({
    aiProfileId: spec.aiProfileId,
    label: spec.label,
    referenceImages: [genericModelImageKey(spec.slug, spec.fileName)],
    status: 'READY' as const,
  }));
}

export function genericModelIds(): string[] {
  return GENERIC_MODEL_SPECS.map((spec) => spec.aiProfileId);
}
