export const BACKGROUND_REMOVAL_ENABLED_ENV = 'BACKGROUND_REMOVAL_ENABLED';

/**
 * WARDROBE-62: Gemini background removal is opt-in.
 * Only `true` / `1` / `yes` / `on` (case-insensitive) enable the call.
 * Unset, empty, `false`, and any other value skip it so add-item / photo
 * replace is not blocked when Gemini returns no image.
 */
export function isBackgroundRemovalEnabled(
  value: string | undefined = process.env[BACKGROUND_REMOVAL_ENABLED_ENV],
): boolean {
  const raw = value?.trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}
