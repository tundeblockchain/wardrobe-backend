import {
  extractBearerToken,
  firebaseUidFromPayload,
} from '../../src/shared/firebase-token';

describe('extractBearerToken', () => {
  it('reads a Bearer token from the Authorization header', () => {
    expect(
      extractBearerToken({ headers: { authorization: 'Bearer abc.def.ghi' } }),
    ).toBe('abc.def.ghi');
  });

  it('accepts a capitalized Authorization header', () => {
    expect(
      extractBearerToken({ headers: { Authorization: 'Bearer token-1' } }),
    ).toBe('token-1');
  });

  it('falls back to identitySource when headers are missing', () => {
    expect(
      extractBearerToken({ identitySource: ['Bearer from-source'] }),
    ).toBe('from-source');
  });

  it('rejects a missing header', () => {
    expect(() => extractBearerToken({ headers: {} })).toThrow(
      'Missing Authorization header',
    );
  });

  it('rejects a malformed Bearer header', () => {
    expect(() =>
      extractBearerToken({ headers: { authorization: 'Basic abc' } }),
    ).toThrow('Authorization header must be a Bearer token');
  });

  it('rejects Bearer with no token', () => {
    expect(() =>
      extractBearerToken({ headers: { authorization: 'Bearer   ' } }),
    ).toThrow('Authorization header must be a Bearer token');
  });
});

describe('firebaseUidFromPayload', () => {
  it('prefers uid, then user_id, then sub', () => {
    expect(firebaseUidFromPayload({ uid: 'from-uid', user_id: 'from-user-id', sub: 'from-sub' })).toBe(
      'from-uid',
    );
    expect(firebaseUidFromPayload({ user_id: 'from-user-id', sub: 'from-sub' })).toBe(
      'from-user-id',
    );
    expect(firebaseUidFromPayload({ sub: 'from-sub' })).toBe('from-sub');
  });

  it('returns undefined when all identity claims are empty', () => {
    expect(firebaseUidFromPayload({ sub: '', uid: '  ', user_id: undefined })).toBeUndefined();
    expect(firebaseUidFromPayload({})).toBeUndefined();
  });
});
