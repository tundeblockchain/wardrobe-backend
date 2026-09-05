import {
  CLOTHING_CATEGORIES,
  CLOTHING_COLOURS,
  ClothingCategory,
  ClothingColour,
  DynamoItem,
  GarmentAiMetadata,
  OutfitItem,
  OutfitRecommendation,
} from '../../shared/types';

export const MAX_RECOMMENDATIONS = 8;
export const MAX_ITEMS_PER_SLOT = 6;

/** Wearable core: TOP+BOTTOM, or DRESS. Used to skip vendor calls and empty lists. */
export function hasWearableCore(
  items: Array<{ slot: ClothingCategory }>,
): boolean {
  const hasDress = items.some((item) => item.slot === 'DRESS');
  const hasTop = items.some((item) => item.slot === 'TOP');
  const hasBottom = items.some((item) => item.slot === 'BOTTOM');
  return hasDress || (hasTop && hasBottom);
}

export interface RecommendableItem {
  itemId: string;
  name: string;
  slot: ClothingCategory;
  colours: ClothingColour[];
}

export interface OutfitRecommender {
  recommend(items: RecommendableItem[]): Promise<OutfitRecommendation[]>;
}

const NEUTRAL_COLOURS = new Set<ClothingColour>([
  'BLACK',
  'WHITE',
  'GREY',
  'BEIGE',
  'CREAM',
  'NAVY',
  'BROWN',
  'KHAKI',
  'SILVER',
  'GOLD',
]);

const WARM_COLOURS = new Set<ClothingColour>([
  'RED',
  'ORANGE',
  'YELLOW',
  'PINK',
  'BURGUNDY',
]);

const COOL_COLOURS = new Set<ClothingColour>([
  'BLUE',
  'GREEN',
  'PURPLE',
  'TEAL',
  'OLIVE',
]);

/**
 * Rule-based combinatorial recommender. No vendor / model calls.
 * Tests inject this (or a mock) so CI never needs a live AI model.
 */
export function createRuleBasedRecommender(): OutfitRecommender {
  return {
    recommend(items: RecommendableItem[]): Promise<OutfitRecommendation[]> {
      return Promise.resolve(recommendFromReadyItems(items));
    },
  };
}

export function recommendFromReadyItems(
  items: RecommendableItem[],
): OutfitRecommendation[] {
  const bySlot = groupBySlot(items);
  const tops = takeStable(bySlot.TOP);
  const bottoms = takeStable(bySlot.BOTTOM);
  const dresses = takeStable(bySlot.DRESS);
  const shoes = takeStable(bySlot.SHOES);
  const outerwear = takeStable(bySlot.OUTERWEAR);
  const accessories = takeStable(bySlot.ACCESSORY);
  const bags = takeStable(bySlot.BAG);

  if (tops.length === 0 && bottoms.length === 0 && dresses.length === 0) {
    return [];
  }

  const extras = { shoes, outerwear, accessories, bags };
  const scored: Array<{
    recommendation: OutfitRecommendation;
    score: number;
    signature: string;
  }> = [];

  for (const top of tops) {
    for (const bottom of bottoms) {
      const shoeChoices = shoes.length > 0 ? shoes.slice(0, 2) : [undefined];
      for (const shoe of shoeChoices) {
        const core = shoe ? [top, bottom, shoe] : [top, bottom];
        scored.push(completeOutfit(core, extras));
      }
    }
  }

  for (const dress of dresses) {
    const shoeChoices = shoes.length > 0 ? shoes.slice(0, 2) : [undefined];
    for (const shoe of shoeChoices) {
      const core = shoe ? [dress, shoe] : [dress];
      scored.push(completeOutfit(core, extras));
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.signature.localeCompare(b.signature);
  });

  const seen = new Set<string>();
  const recommendations: OutfitRecommendation[] = [];
  for (const candidate of scored) {
    if (seen.has(candidate.signature)) {
      continue;
    }
    seen.add(candidate.signature);
    recommendations.push(candidate.recommendation);
    if (recommendations.length >= MAX_RECOMMENDATIONS) {
      break;
    }
  }

  return recommendations;
}

/**
 * READY items only. Prefer AI category/colours; fall back to user fields.
 * Items without a controlled slot are skipped.
 */
export function toRecommendableItem(
  item: DynamoItem,
): RecommendableItem | undefined {
  if (item.entityType !== 'ITEM') {
    return undefined;
  }
  if (item.processingStatus !== 'READY') {
    return undefined;
  }

  const itemId = typeof item.itemId === 'string' ? item.itemId.trim() : '';
  if (!itemId) {
    return undefined;
  }

  const slot = resolveSlot(item);
  if (!slot) {
    return undefined;
  }

  const name =
    typeof item.name === 'string' && item.name.trim()
      ? item.name.trim()
      : itemId;

  return {
    itemId,
    name,
    slot,
    colours: resolveColours(item),
  };
}

export function resolveSlot(item: DynamoItem): ClothingCategory | undefined {
  const ai = asAiMetadata(item.ai);
  return (
    canonicalizeCategory(ai?.detectedCategory) ??
    canonicalizeCategory(item.category)
  );
}

export function resolveColours(item: DynamoItem): ClothingColour[] {
  const ai = asAiMetadata(item.ai);
  const detected = canonicalizeColours(ai?.detectedColours);
  if (detected.length > 0) {
    return detected;
  }
  return canonicalizeColours(item.colours);
}

export function colourCompatibility(a: ClothingColour[], b: ClothingColour[]): number {
  if (a.length === 0 || b.length === 0) {
    return 1;
  }

  let best = 0;
  for (const left of a) {
    for (const right of b) {
      best = Math.max(best, pairScore(left, right));
    }
  }
  return best;
}

function completeOutfit(
  core: RecommendableItem[],
  extras: {
    shoes: RecommendableItem[];
    outerwear: RecommendableItem[];
    accessories: RecommendableItem[];
    bags: RecommendableItem[];
  },
): { recommendation: OutfitRecommendation; score: number; signature: string } {
  const used = new Set(core.map((item) => item.itemId));
  const pieces = [...core];
  const hasShoes = pieces.some((item) => item.slot === 'SHOES');

  if (!hasShoes) {
    addBestMatch(pieces, extras.shoes, used);
  }
  addBestMatch(pieces, extras.outerwear, used);
  addBestMatch(pieces, extras.accessories, used);
  addBestMatch(pieces, extras.bags, used);

  const items: OutfitItem[] = pieces.map((item) => ({
    itemId: item.itemId,
    slot: item.slot,
  }));

  return {
    recommendation: {
      name: nameOutfit(pieces),
      items,
    },
    score: outfitScore(pieces),
    signature: items
      .map((item) => `${item.slot}:${item.itemId}`)
      .sort()
      .join('|'),
  };
}

function addBestMatch(
  pieces: RecommendableItem[],
  candidates: RecommendableItem[],
  used: Set<string>,
): void {
  const available = candidates.filter((item) => !used.has(item.itemId));
  if (available.length === 0) {
    return;
  }

  let best = available[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of available) {
    const score = extrasScore(pieces, candidate);
    if (
      score > bestScore ||
      (score === bestScore && candidate.itemId.localeCompare(best.itemId) < 0)
    ) {
      best = candidate;
      bestScore = score;
    }
  }

  pieces.push(best);
  used.add(best.itemId);
}

function extrasScore(
  pieces: RecommendableItem[],
  candidate: RecommendableItem,
): number {
  if (pieces.length === 0) {
    return 0;
  }
  const total = pieces.reduce(
    (sum, piece) => sum + colourCompatibility(piece.colours, candidate.colours),
    0,
  );
  return total / pieces.length;
}

function outfitScore(pieces: RecommendableItem[]): number {
  if (pieces.length < 2) {
    return pieces.length;
  }

  let total = 0;
  let pairs = 0;
  for (let i = 0; i < pieces.length; i += 1) {
    for (let j = i + 1; j < pieces.length; j += 1) {
      total += colourCompatibility(pieces[i].colours, pieces[j].colours);
      pairs += 1;
    }
  }

  const completeness =
    (pieces.some((item) => item.slot === 'SHOES') ? 1 : 0) +
    (pieces.some((item) => item.slot === 'OUTERWEAR') ? 0.25 : 0);
  return total / pairs + completeness;
}

function nameOutfit(pieces: RecommendableItem[]): string {
  const dress = pieces.find((item) => item.slot === 'DRESS');
  if (dress) {
    const colour = dress.colours[0];
    return colour ? `${titleCase(colour)} dress look` : 'Suggested dress look';
  }

  const top = pieces.find((item) => item.slot === 'TOP');
  const bottom = pieces.find((item) => item.slot === 'BOTTOM');
  const topColour = top?.colours[0];
  const bottomColour = bottom?.colours[0];
  if (topColour && bottomColour) {
    return `${titleCase(topColour)} + ${titleCase(bottomColour)} look`;
  }
  if (top && bottom) {
    return `${top.name} + ${bottom.name}`;
  }
  return 'Suggested outfit';
}

function groupBySlot(
  items: RecommendableItem[],
): Record<ClothingCategory, RecommendableItem[]> {
  const grouped = Object.fromEntries(
    CLOTHING_CATEGORIES.map((slot) => [slot, [] as RecommendableItem[]]),
  ) as Record<ClothingCategory, RecommendableItem[]>;

  for (const item of items) {
    grouped[item.slot].push(item);
  }
  return grouped;
}

function takeStable(items: RecommendableItem[]): RecommendableItem[] {
  return [...items]
    .sort((a, b) => a.itemId.localeCompare(b.itemId))
    .slice(0, MAX_ITEMS_PER_SLOT);
}

function pairScore(left: ClothingColour, right: ClothingColour): number {
  if (left === right) {
    return 3;
  }
  if (left === 'MULTICOLOUR' || right === 'MULTICOLOUR') {
    return NEUTRAL_COLOURS.has(left) || NEUTRAL_COLOURS.has(right) ? 2 : 1;
  }
  if (NEUTRAL_COLOURS.has(left) || NEUTRAL_COLOURS.has(right)) {
    return 2;
  }
  if (
    (WARM_COLOURS.has(left) && WARM_COLOURS.has(right)) ||
    (COOL_COLOURS.has(left) && COOL_COLOURS.has(right))
  ) {
    return 2;
  }
  return 0;
}

function canonicalizeCategory(value: unknown): ClothingCategory | undefined {
  const normalized = normalizeToken(value);
  if (!normalized) {
    return undefined;
  }
  if ((CLOTHING_CATEGORIES as readonly string[]).includes(normalized)) {
    return normalized as ClothingCategory;
  }
  return undefined;
}

function canonicalizeColours(value: unknown): ClothingColour[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<ClothingColour>();
  const colours: ClothingColour[] = [];
  for (const entry of value) {
    const normalized = normalizeToken(entry);
    if (
      normalized &&
      (CLOTHING_COLOURS as readonly string[]).includes(normalized) &&
      !seen.has(normalized as ClothingColour)
    ) {
      const colour = normalized as ClothingColour;
      seen.add(colour);
      colours.push(colour);
    }
  }
  return colours;
}

function asAiMetadata(value: unknown): GarmentAiMetadata | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as GarmentAiMetadata;
}

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return normalized || undefined;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}
