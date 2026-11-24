import {
  DEFAULT_SUPPORT_INBOX_ALLOWED_ORIGINS,
  parseSupportInboxAllowedOrigins,
} from '../../lib/support-inbox-cors';

describe('parseSupportInboxAllowedOrigins (WARDROBE-281)', () => {
  it('uses the Netlify and localhost defaults when unset', () => {
    expect(parseSupportInboxAllowedOrigins(undefined)).toEqual([
      ...DEFAULT_SUPPORT_INBOX_ALLOWED_ORIGINS,
    ]);
    expect(parseSupportInboxAllowedOrigins('')).toEqual([
      ...DEFAULT_SUPPORT_INBOX_ALLOWED_ORIGINS,
    ]);
    expect(parseSupportInboxAllowedOrigins(undefined)).toEqual([
      'https://wende-wardrobe.netlify.app',
      'https://deploy-preview-*--wende-wardrobe.netlify.app',
      'http://localhost:*',
      'http://localhost:5173',
    ]);
  });

  it('splits a comma-separated override and trims entries', () => {
    expect(
      parseSupportInboxAllowedOrigins(
        ' https://a.example , http://localhost:* ',
      ),
    ).toEqual(['https://a.example', 'http://localhost:*']);
  });

  it('rejects a wildcard-all origin', () => {
    expect(() => parseSupportInboxAllowedOrigins('*')).toThrow(
      /supportInboxAllowedOrigins must not include "\*"/,
    );
    expect(() =>
      parseSupportInboxAllowedOrigins('https://a.example,*'),
    ).toThrow(/supportInboxAllowedOrigins must not include "\*"/);
  });
});
