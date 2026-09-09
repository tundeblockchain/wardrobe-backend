import {
  CLOTHING_CATEGORIES,
  CLOTHING_SUBCATEGORIES,
  ClothingCategory,
  ClothingSubcategory,
  DynamoItem,
  GarmentAiMetadata,
} from '../../shared/types';

/**
 * WARDROBE-75 — ground try-on in the outfit's actual garments.
 *
 * The worker already loads each clothing item. This module reads the
 * existing category / subcategory (user fields first, AI detected as
 * fallback) plus the outfit item list, then:
 *   1. composes which pieces should actually be worn together
 *   2. builds a Gemini prompt that names those pieces and forbids
 *      incompatible layering (e.g. jeans on a dress)
 */

const ONE_PIECE_SUBCATEGORIES = new Set<ClothingSubcategory>([
  'DRESS',
  'JUMPSUIT',
  'ROMPER',
]);

const BOTTOM_SUBCATEGORIES = new Set<ClothingSubcategory>([
  'JEANS',
  'TROUSERS',
  'SHORTS',
  'SKIRT',
]);

const TOP_SUBCATEGORIES = new Set<ClothingSubcategory>([
  'TSHIRT',
  'SHIRT',
  'BLOUSE',
  'POLO',
  'SWEATER',
  'HOODIE',
]);

export interface OutfitTryOnGarment {
  slot: string;
  objectKey: string;
  category?: ClothingCategory;
  subcategory?: string;
  name?: string;
}

export interface OmittedGarment {
  garment: OutfitTryOnGarment;
  reason: string;
}

export interface OutfitComposeResult {
  garments: OutfitTryOnGarment[];
  worn: OutfitTryOnGarment[];
  omitted: OmittedGarment[];
}

export function garmentFromClothingItem(
  item: DynamoItem,
  slot: string,
  objectKey: string,
): OutfitTryOnGarment {
  const garment: OutfitTryOnGarment = { slot, objectKey };
  const category = resolveItemCategory(item, slot);
  const subcategory = resolveItemSubcategory(item);
  const name = trimToken(item.name);
  if (category) {
    garment.category = category;
  }
  if (subcategory) {
    garment.subcategory = subcategory;
  }
  if (name) {
    garment.name = name;
  }
  return garment;
}

/** User-set category, then AI detected, then the outfit slot. */
export function resolveItemCategory(
  item: DynamoItem,
  slot?: string,
): ClothingCategory | undefined {
  return (
    canonicalizeCategory(item.category) ??
    canonicalizeCategory(asAi(item.ai)?.detectedCategory) ??
    canonicalizeCategory(slot)
  );
}

/** User-set subcategory, then AI detected. */
export function resolveItemSubcategory(item: DynamoItem): string | undefined {
  const user = trimToken(item.subcategory);
  if (user) {
    return canonicalizeSubcategory(user) ?? user.toUpperCase();
  }
  const detected = asAi(item.ai)?.detectedSubcategory;
  return canonicalizeSubcategory(detected) ?? trimToken(detected)?.toUpperCase();
}

/**
 * A DRESS / JUMPSUIT / ROMPER covers torso and legs. Pairing it with a
 * BOTTOM (jeans, trousers, …) or a separate TOP is incompatible layering.
 * OUTERWEAR, SHOES, ACCESSORY, and BAG stay wearable with a one-piece.
 */
export function composeOutfitTryOn(
  garments: OutfitTryOnGarment[],
): OutfitComposeResult {
  const hasOnePiece = garments.some(isOnePiece);
  if (!hasOnePiece) {
    return { garments, worn: [...garments], omitted: [] };
  }

  const worn: OutfitTryOnGarment[] = [];
  const omitted: OmittedGarment[] = [];
  for (const garment of garments) {
    const reason = onePieceIncompatibility(garment);
    if (reason) {
      omitted.push({ garment, reason });
    } else {
      worn.push(garment);
    }
  }
  return { garments, worn, omitted };
}

export function buildTryOnPrompt(composed: OutfitComposeResult): string {
  const lines = [
    'Create a single photorealistic virtual try-on image.',
    'The first image(s) show the person or model. The following images are the garments to wear from this outfit, each labeled by slot, category, and subcategory.',
    "Dress that same person in only the worn garments below. Keep the person's face, body shape, skin tone, hair, and pose. Fit the clothes naturally.",
    '',
    'Outfit items (ground the render in this list; do not invent pieces):',
    ...composed.garments.map((garment) => `- ${formatGarment(garment)}`),
    '',
    'Wear these pieces together:',
    ...(composed.worn.length > 0
      ? composed.worn.map((garment) => `- ${formatGarment(garment)}`)
      : ['- (none)']),
  ];

  if (composed.omitted.length > 0) {
    lines.push('', 'Do not wear these incompatible pieces:');
    for (const { garment, reason } of composed.omitted) {
      lines.push(`- ${formatGarment(garment)} — ${reason}`);
    }
  }

  lines.push(
    '',
    'Composition rules:',
    '- Wear only the garments listed as worn. Do not add extra garments, accessories, logos, or text.',
    '- A DRESS, JUMPSUIT, or ROMPER is a one-piece that covers the torso and legs.',
    '- Do not put jeans on a dress. Do not layer a BOTTOM (jeans, trousers, shorts, skirt) or a separate TOP on a one-piece.',
    '- TOP and BOTTOM are a pair (top on the torso, bottom on the legs) only when no one-piece is worn.',
    '- OUTERWEAR may go over a dress or over a top. SHOES, ACCESSORY, and BAG may be worn with either core.',
    'Return one full-body PNG.',
  );

  return lines.join('\n');
}

export function garmentImageLabel(garment: OutfitTryOnGarment): string {
  return `Garment ${formatGarment(garment)}`;
}

export function formatGarment(garment: OutfitTryOnGarment): string {
  const parts = [`slot=${garment.slot || 'UNKNOWN'}`];
  if (garment.category) {
    parts.push(`category=${garment.category}`);
  }
  if (garment.subcategory) {
    parts.push(`subcategory=${garment.subcategory}`);
  }
  if (garment.name) {
    parts.push(`name=${garment.name}`);
  }
  return parts.join('; ');
}

export function isOnePiece(garment: OutfitTryOnGarment): boolean {
  const subcategory = canonicalizeSubcategory(garment.subcategory);
  if (subcategory && ONE_PIECE_SUBCATEGORIES.has(subcategory)) {
    return true;
  }
  return (
    canonicalizeCategory(garment.category) === 'DRESS' ||
    canonicalizeCategory(garment.slot) === 'DRESS'
  );
}

function onePieceIncompatibility(garment: OutfitTryOnGarment): string | undefined {
  if (isOnePiece(garment)) {
    return undefined;
  }

  const category = canonicalizeCategory(garment.category);
  const slot = canonicalizeCategory(garment.slot);
  const subcategory = canonicalizeSubcategory(garment.subcategory);

  if (
    category === 'BOTTOM' ||
    slot === 'BOTTOM' ||
    (subcategory && BOTTOM_SUBCATEGORIES.has(subcategory))
  ) {
    return 'BOTTOM cannot be layered on a DRESS one-piece (do not put jeans on a dress)';
  }

  if (
    category === 'TOP' ||
    slot === 'TOP' ||
    (subcategory && TOP_SUBCATEGORIES.has(subcategory))
  ) {
    return 'TOP cannot be layered on a DRESS one-piece';
  }

  return undefined;
}

export function canonicalizeCategory(value: unknown): ClothingCategory | undefined {
  const normalized = normalizeToken(value);
  if (normalized && (CLOTHING_CATEGORIES as readonly string[]).includes(normalized)) {
    return normalized as ClothingCategory;
  }
  return undefined;
}

export function canonicalizeSubcategory(
  value: unknown,
): ClothingSubcategory | undefined {
  const normalized = normalizeToken(value);
  if (
    normalized &&
    (CLOTHING_SUBCATEGORIES as readonly string[]).includes(normalized)
  ) {
    return normalized as ClothingSubcategory;
  }
  return undefined;
}

function asAi(value: unknown): GarmentAiMetadata | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as GarmentAiMetadata;
}

function trimToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeToken(value: unknown): string | undefined {
  const trimmed = trimToken(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed.toUpperCase().replace(/[\s-]+/g, '_');
}
