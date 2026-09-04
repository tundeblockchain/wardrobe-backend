import { Errors } from './errors';
import { CLOTHING_CATEGORIES, ClothingCategory } from './types';

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
  const category = requireNonEmptyString(value, 'category', 32);
  if (!(CLOTHING_CATEGORIES as readonly string[]).includes(category)) {
    throw Errors.validation(
      `category must be one of: ${CLOTHING_CATEGORIES.join(', ')}.`,
    );
  }
  return category as ClothingCategory;
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
