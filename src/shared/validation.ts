import { Errors } from './errors';
import {
  CLOTHING_CATEGORIES,
  CLOTHING_COLOURS,
  CLOTHING_SUBCATEGORIES,
  ClothingCategory,
  ClothingColour,
  ClothingSubcategory,
  OutfitItem,
  OutfitSlot,
} from './types';

export function requireNonEmptyString(
  value: unknown,
  field: string,
  maxLength = 100,
): string {
  if (typeof value !== 'string') {
    throw Errors.validation(`${field} must be a string.`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw Errors.validation(`${field} is required.`);
  }
  if (trimmed.length > maxLength) {
    throw Errors.validation(`${field} must be ${maxLength} characters or fewer.`);
  }

  return trimmed;
}

export function optionalNonEmptyString(
  value: unknown,
  field: string,
  maxLength = 100,
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return requireNonEmptyString(value, field, maxLength);
}

export function requireCategory(value: unknown): ClothingCategory {
  return requireControlledSlot(value, 'category');
}

export function requireColour(value: unknown): ClothingColour {
  const colour = requireNonEmptyString(value, 'colour', 32);
  if (!(CLOTHING_COLOURS as readonly string[]).includes(colour)) {
    throw Errors.validation(
      `colour must be one of: ${CLOTHING_COLOURS.join(', ')}.`,
    );
  }
  return colour as ClothingColour;
}

export function requireSubcategory(value: unknown): ClothingSubcategory {
  const subcategory = requireNonEmptyString(value, 'subcategory', 32);
  if (!(CLOTHING_SUBCATEGORIES as readonly string[]).includes(subcategory)) {
    throw Errors.validation(
      `subcategory must be one of: ${CLOTHING_SUBCATEGORIES.join(', ')}.`,
    );
  }
  return subcategory as ClothingSubcategory;
}

/** Missing / blank query values are omitted; present values must be non-empty. */
export function optionalQueryString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return requireNonEmptyString(value, field, 32);
}

export function requireSlot(value: unknown, field = 'slot'): OutfitSlot {
  return requireControlledSlot(value, field);
}

function requireControlledSlot(
  value: unknown,
  field: string,
): ClothingCategory {
  const slot = requireNonEmptyString(value, field, 32);
  if (!(CLOTHING_CATEGORIES as readonly string[]).includes(slot)) {
    throw Errors.validation(
      `${field} must be one of: ${CLOTHING_CATEGORIES.join(', ')}.`,
    );
  }
  return slot as ClothingCategory;
}

const UNIQUE_SLOTS = new Set<OutfitSlot>(
  CLOTHING_CATEGORIES.filter((slot) => slot !== 'ACCESSORY'),
);

export function requireOutfitItems(value: unknown): OutfitItem[] {
  if (!Array.isArray(value)) {
    throw Errors.validation('items must be an array.');
  }
  if (value.length === 0) {
    throw Errors.validation('items must contain at least one item.');
  }

  const items: OutfitItem[] = [];
  const seenItemIds = new Set<string>();
  const seenUniqueSlots = new Set<OutfitSlot>();

  value.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw Errors.validation(`items[${index}] must be an object.`);
    }

    const raw = entry as { itemId?: unknown; slot?: unknown };
    const itemId = requireNonEmptyString(raw.itemId, `items[${index}].itemId`);
    const slot = requireSlot(raw.slot, `items[${index}].slot`);

    if (seenItemIds.has(itemId)) {
      throw Errors.validation('items must not contain duplicate itemId values.');
    }
    seenItemIds.add(itemId);

    if (UNIQUE_SLOTS.has(slot)) {
      if (seenUniqueSlots.has(slot)) {
        throw Errors.validation(
          `slot ${slot} can only appear once (ACCESSORY may appear multiple times).`,
        );
      }
      seenUniqueSlots.add(slot);
    }

    items.push({ itemId, slot });
  });

  return items;
}

export function optionalStringArray(
  value: unknown,
  field: string,
  maxLength = 40,
): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw Errors.validation(`${field} must be an array of strings.`);
  }

  return value.map((entry, index) =>
    requireNonEmptyString(entry, `${field}[${index}]`, maxLength),
  );
}

export function requireOwnedImageKey(value: unknown, userId: string): string {
  const imageKey = requireNonEmptyString(value, 'imageKey', 1024);

  if (
    imageKey.includes('..') ||
    imageKey.includes('//') ||
    imageKey.startsWith('/') ||
    imageKey.includes('\\') ||
    imageKey.includes('\0')
  ) {
    throw Errors.validation('imageKey is not a valid object key.');
  }

  const ownedPrefix = `users/${userId}/`;
  if (!imageKey.startsWith(ownedPrefix)) {
    throw Errors.validation('imageKey must belong to the authenticated user.');
  }

  const remainder = imageKey.slice(ownedPrefix.length);
  if (!remainder || remainder.endsWith('/')) {
    throw Errors.validation(
      'imageKey must be under users/{userId}/uploads/ or another owned path.',
    );
  }

  return imageKey;
}

export function optionalInteger(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw Errors.validation(`${field} must be an integer.`);
  }

  return value;
}
