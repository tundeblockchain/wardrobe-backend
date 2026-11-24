import {
  nextAdminCustomClaims,
  parseGrantSupportAdminArgs,
} from '../../scripts/grant-support-admin';

describe('grant-support-admin script (WARDROBE-284)', () => {
  it('parses uid grant and email grant', () => {
    expect(parseGrantSupportAdminArgs(['--uid', 'firebase-uid-1'])).toEqual({
      uid: 'firebase-uid-1',
      revoke: false,
    });
    expect(
      parseGrantSupportAdminArgs(['--email', 'operator@example.com']),
    ).toEqual({
      email: 'operator@example.com',
      revoke: false,
    });
  });

  it('parses revoke', () => {
    expect(
      parseGrantSupportAdminArgs(['--uid', 'firebase-uid-1', '--revoke']),
    ).toEqual({
      uid: 'firebase-uid-1',
      revoke: true,
    });
  });

  it('rejects missing identifier and both identifiers', () => {
    expect(() => parseGrantSupportAdminArgs([])).toThrow(/exactly one/);
    expect(() =>
      parseGrantSupportAdminArgs([
        '--uid',
        'firebase-uid-1',
        '--email',
        'operator@example.com',
      ]),
    ).toThrow(/exactly one/);
  });

  it('merges admin true and removes it on revoke without dropping other claims', () => {
    expect(nextAdminCustomClaims({ beta: true }, true)).toEqual({
      beta: true,
      admin: true,
    });
    expect(nextAdminCustomClaims({ admin: true, beta: true }, false)).toEqual({
      beta: true,
    });
  });
});
