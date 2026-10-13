import {
  DEFAULT_UPLOAD_ALLOWED_ORIGINS,
  parseUploadAllowedOrigins,
} from '../../lib/upload-cors';

describe('parseUploadAllowedOrigins (WARDROBE-176)', () => {
  it('uses the Netlify, deploy-preview, and localhost defaults when unset', () => {
    expect(parseUploadAllowedOrigins(undefined)).toEqual([
      ...DEFAULT_UPLOAD_ALLOWED_ORIGINS,
    ]);
    expect(parseUploadAllowedOrigins('')).toEqual([
      ...DEFAULT_UPLOAD_ALLOWED_ORIGINS,
    ]);
    expect(parseUploadAllowedOrigins('   ,  ')).toEqual([
      ...DEFAULT_UPLOAD_ALLOWED_ORIGINS,
    ]);
    expect(parseUploadAllowedOrigins(undefined)).toEqual([
      'https://wende-wardrobe.netlify.app',
      'https://deploy-preview-*--wende-wardrobe.netlify.app',
      'http://localhost:5173',
    ]);
  });

  it('splits a comma-separated override and trims entries', () => {
    expect(
      parseUploadAllowedOrigins(
        ' https://a.example , https://deploy-preview-*--a.netlify.app ',
      ),
    ).toEqual([
      'https://a.example',
      'https://deploy-preview-*--a.netlify.app',
    ]);
  });

  it('rejects a wildcard-all origin', () => {
    expect(() => parseUploadAllowedOrigins('*')).toThrow(
      /uploadAllowedOrigins must not include "\*"/,
    );
    expect(() => parseUploadAllowedOrigins('https://a.example,*')).toThrow(
      /uploadAllowedOrigins must not include "\*"/,
    );
  });
});
