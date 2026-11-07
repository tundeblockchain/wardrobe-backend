import { getItem, keys, setUserTrackingConsent } from './dynamodb';
import { Errors } from './errors';

/**
 * App tracking consent on `USER#{uid} / PROFILE` (WARDROBE-252).
 *
 * Exact boolean `true` only. Missing PROFILE, missing flag, `false`, and
 * any other stored value are no consent.
 */
export function trackingConsentGranted(value: unknown): boolean {
  return value === true;
}

export function parseTrackingConsent(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw Errors.validation('trackingConsent must be a boolean.');
  }
  return value;
}

export async function loadUserTrackingConsent(userId: string): Promise<boolean> {
  const profile = await getItem(keys.userPk(userId), keys.profileSk);
  return trackingConsentGranted(profile?.trackingConsent);
}

export { setUserTrackingConsent };
