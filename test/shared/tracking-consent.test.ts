import { AppError } from '../../src/shared/errors';
import {
  parseTrackingConsent,
  trackingConsentGranted,
} from '../../src/shared/tracking-consent';

describe('trackingConsent (WARDROBE-252)', () => {
  it('grants only exact boolean true', () => {
    expect(trackingConsentGranted(true)).toBe(true);
    expect(trackingConsentGranted(false)).toBe(false);
    expect(trackingConsentGranted(undefined)).toBe(false);
    expect(trackingConsentGranted('true')).toBe(false);
    expect(trackingConsentGranted(1)).toBe(false);
  });

  it('parses a required JSON boolean and rejects other types', () => {
    expect(parseTrackingConsent(true)).toBe(true);
    expect(parseTrackingConsent(false)).toBe(false);
    for (const value of [undefined, null, 'true', 1, {}]) {
      try {
        parseTrackingConsent(value);
        throw new Error('expected validation error');
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe('VALIDATION_ERROR');
        expect((error as AppError).message).toBe(
          'trackingConsent must be a boolean.',
        );
      }
    }
  });
});
