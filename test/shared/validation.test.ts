import {
  optionalInteger,
  optionalNonEmptyString,
  optionalStringArray,
  requireCategory,
  requireNonEmptyString,
  requireOwnedImageKey,
} from '../../src/shared/validation';
import { AppError } from '../../src/shared/errors';

describe('validation', () => {
  describe('requireNonEmptyString', () => {
    it('should return trimmed string for valid input', () => {
      expect(requireNonEmptyString('  hello  ', 'name')).toBe('hello');
    });

    it('should accept string at max length boundary', () => {
      const input = 'a'.repeat(100);
      expect(requireNonEmptyString(input, 'name', 100)).toBe(input);
    });

    it('should throw VALIDATION_ERROR for non-string input', () => {
      expect(() => requireNonEmptyString(123, 'name')).toThrow(AppError);
      try {
        requireNonEmptyString(123, 'name');
      } catch (err) {
        const appErr = err as AppError;
        expect(appErr.code).toBe('VALIDATION_ERROR');
        expect(appErr.message).toBe('name must be a string.');
        expect(appErr.statusCode).toBe(400);
      }
    });

    it('should throw VALIDATION_ERROR for empty string', () => {
      expect(() => requireNonEmptyString('   ', 'name')).toThrow(AppError);
      try {
        requireNonEmptyString('   ', 'name');
      } catch (err) {
        const appErr = err as AppError;
        expect(appErr.code).toBe('VALIDATION_ERROR');
        expect(appErr.message).toBe('name is required.');
      }
    });

    it('should throw VALIDATION_ERROR for string exceeding max length', () => {
      const longString = 'a'.repeat(101);
      expect(() => requireNonEmptyString(longString, 'name', 100)).toThrow(AppError);
      try {
        requireNonEmptyString(longString, 'name', 100);
      } catch (err) {
        const appErr = err as AppError;
        expect(appErr.code).toBe('VALIDATION_ERROR');
        expect(appErr.message).toBe('name must be 100 characters or fewer.');
      }
    });

    it('should throw VALIDATION_ERROR for null', () => {
      expect(() => requireNonEmptyString(null, 'name')).toThrow(AppError);
    });

    it('should throw VALIDATION_ERROR for undefined', () => {
      expect(() => requireNonEmptyString(undefined, 'name')).toThrow(AppError);
    });

    it('should use custom maxLength', () => {
      const input = 'ab';
      expect(requireNonEmptyString(input, 'name', 5)).toBe('ab');
      expect(() => requireNonEmptyString('abcdef', 'name', 5)).toThrow(AppError);
    });
  });

  describe('optionalInteger', () => {
    it('returns undefined for missing values', () => {
      expect(optionalInteger(undefined, 'contentLength')).toBeUndefined();
      expect(optionalInteger(null, 'contentLength')).toBeUndefined();
      expect(optionalInteger('', 'contentLength')).toBeUndefined();
    });

    it('returns an integer as-is', () => {
      expect(optionalInteger(0, 'contentLength')).toBe(0);
      expect(optionalInteger(10, 'contentLength')).toBe(10);
    });

    it('throws VALIDATION_ERROR for non-integers', () => {
      expect(() => optionalInteger(1.5, 'contentLength')).toThrow(AppError);
      expect(() => optionalInteger('10', 'contentLength')).toThrow(AppError);
      try {
        optionalInteger(1.5, 'contentLength');
      } catch (err) {
        const appErr = err as AppError;
        expect(appErr.code).toBe('VALIDATION_ERROR');
        expect(appErr.message).toBe('contentLength must be an integer.');
      }
    });
  });

  describe('optionalNonEmptyString', () => {
    it('returns undefined for missing values', () => {
      expect(optionalNonEmptyString(undefined, 'brand')).toBeUndefined();
      expect(optionalNonEmptyString(null, 'brand')).toBeUndefined();
      expect(optionalNonEmptyString('', 'brand')).toBeUndefined();
    });

    it('returns a trimmed string when present', () => {
      expect(optionalNonEmptyString('  Nike  ', 'brand')).toBe('Nike');
    });
  });

  describe('requireCategory', () => {
    it('accepts each controlled category', () => {
      for (const category of [
        'TOP',
        'BOTTOM',
        'DRESS',
        'OUTERWEAR',
        'SHOES',
        'ACCESSORY',
        'BAG',
      ]) {
        expect(requireCategory(category)).toBe(category);
      }
    });

    it('rejects free-text categories', () => {
      expect(() => requireCategory('HAT')).toThrow(AppError);
      try {
        requireCategory('HAT');
      } catch (err) {
        const appErr = err as AppError;
        expect(appErr.code).toBe('VALIDATION_ERROR');
        expect(appErr.message).toBe(
          'category must be one of: TOP, BOTTOM, DRESS, OUTERWEAR, SHOES, ACCESSORY, BAG.',
        );
      }
    });
  });

  describe('optionalStringArray', () => {
    it('returns undefined for missing values', () => {
      expect(optionalStringArray(undefined, 'colours')).toBeUndefined();
      expect(optionalStringArray(null, 'colours')).toBeUndefined();
    });

    it('returns trimmed strings', () => {
      expect(optionalStringArray(['  BLACK  '], 'colours')).toEqual(['BLACK']);
    });

    it('throws VALIDATION_ERROR for non-arrays', () => {
      expect(() => optionalStringArray('BLACK', 'colours')).toThrow(AppError);
    });
  });

  describe('requireOwnedImageKey', () => {
    const userId = 'firebase-uid-owner';

    it('accepts keys under users/{userId}/uploads/', () => {
      expect(
        requireOwnedImageKey(`users/${userId}/uploads/photo.jpg`, userId),
      ).toBe(`users/${userId}/uploads/photo.jpg`);
    });

    it('accepts another owned user path', () => {
      expect(
        requireOwnedImageKey(`users/${userId}/items/item_1/original.jpg`, userId),
      ).toBe(`users/${userId}/items/item_1/original.jpg`);
    });

    it('rejects a cross-user key', () => {
      expect(() =>
        requireOwnedImageKey('users/other-user/uploads/photo.jpg', userId),
      ).toThrow(AppError);
    });

    it('rejects path traversal', () => {
      expect(() =>
        requireOwnedImageKey(`users/${userId}/uploads/../secret.jpg`, userId),
      ).toThrow(AppError);
    });
  });
});
