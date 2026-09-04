import { Errors } from './errors';

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
