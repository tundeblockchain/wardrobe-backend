import {
  ClothingCategory,
  ClothingColour,
  ClothingSubcategory,
  DynamoItem,
  GarmentAiMetadata,
} from '../../shared/types';
import {
  isIsoDate,
  optionalIsoDate,
  optionalQueryString,
  requireCategory,
  requireColour,
  requireSubcategory,
} from '../../shared/validation';

/**
 * Smart list filters for `GET /wardrobes/{wardrobeId}/items`.
 *
 * Matching is inclusive OR within each dimension, AND across dimensions:
 * - `category` matches user `category` OR `ai.detectedCategory`
 * - `colour` matches user `colours` OR `ai.detectedColours`
 * - `subcategory` matches user `subcategory` OR `ai.detectedSubcategory`
 * - `acquiredAfter` / `acquiredBefore` match stored `acquiredAt` (inclusive
 *   `YYYY-MM-DD`). Items with no `acquiredAt` are excluded when either
 *   bound is present.
 *
 * Query `userId` is ignored. Identity always comes from `getUserId`.
 */
export interface ItemListFilters {
  category?: ClothingCategory;
  colour?: ClothingColour;
  subcategory?: ClothingSubcategory;
  acquiredAfter?: string;
  acquiredBefore?: string;
}

export function parseItemListFilters(
  query: Record<string, string | undefined> | undefined,
): ItemListFilters {
  const filters: ItemListFilters = {};

  const category = optionalQueryString(query?.category, 'category');
  if (category !== undefined) {
    filters.category = requireCategory(category);
  }

  const colour = optionalQueryString(query?.colour, 'colour');
  if (colour !== undefined) {
    filters.colour = requireColour(colour);
  }

  const subcategory = optionalQueryString(query?.subcategory, 'subcategory');
  if (subcategory !== undefined) {
    filters.subcategory = requireSubcategory(subcategory);
  }

  const acquiredAfter = optionalIsoDate(query?.acquiredAfter, 'acquiredAfter');
  if (acquiredAfter !== undefined) {
    filters.acquiredAfter = acquiredAfter;
  }

  const acquiredBefore = optionalIsoDate(query?.acquiredBefore, 'acquiredBefore');
  if (acquiredBefore !== undefined) {
    filters.acquiredBefore = acquiredBefore;
  }

  return filters;
}

export function itemMatchesFilters(
  item: DynamoItem,
  filters: ItemListFilters,
): boolean {
  if (filters.category && !matchesCategory(item, filters.category)) {
    return false;
  }
  if (filters.colour && !matchesColour(item, filters.colour)) {
    return false;
  }
  if (filters.subcategory && !matchesSubcategory(item, filters.subcategory)) {
    return false;
  }
  if (!matchesAcquiredRange(item, filters)) {
    return false;
  }
  return true;
}

function matchesCategory(
  item: DynamoItem,
  category: ClothingCategory,
): boolean {
  if (normalizeToken(item.category) === category) {
    return true;
  }
  return normalizeToken(asAi(item.ai)?.detectedCategory) === category;
}

function matchesColour(item: DynamoItem, colour: ClothingColour): boolean {
  if (stringList(item.colours).some((entry) => normalizeToken(entry) === colour)) {
    return true;
  }
  return stringList(asAi(item.ai)?.detectedColours).some(
    (entry) => normalizeToken(entry) === colour,
  );
}

function matchesSubcategory(
  item: DynamoItem,
  subcategory: ClothingSubcategory,
): boolean {
  if (normalizeToken(item.subcategory) === subcategory) {
    return true;
  }
  return normalizeToken(asAi(item.ai)?.detectedSubcategory) === subcategory;
}

function matchesAcquiredRange(
  item: DynamoItem,
  filters: ItemListFilters,
): boolean {
  if (!filters.acquiredAfter && !filters.acquiredBefore) {
    return true;
  }
  if (!isIsoDate(item.acquiredAt)) {
    return false;
  }
  const acquiredAt = item.acquiredAt.trim();
  if (filters.acquiredAfter && acquiredAt < filters.acquiredAfter) {
    return false;
  }
  if (filters.acquiredBefore && acquiredAt > filters.acquiredBefore) {
    return false;
  }
  return true;
}

function stringList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  return normalized || undefined;
}

function asAi(value: unknown): GarmentAiMetadata | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as GarmentAiMetadata;
}
