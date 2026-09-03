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
