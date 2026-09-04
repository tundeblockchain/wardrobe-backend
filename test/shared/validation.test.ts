import { requireNonEmptyString } from '../../src/shared/validation';
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
});
