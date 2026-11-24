import * as fs from 'fs';
import * as path from 'path';
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

  it('contains no credentials; operators supply GOOGLE_APPLICATION_CREDENTIALS', () => {
    const script = fs.readFileSync(
      path.join(__dirname, '../../scripts/grant-support-admin.ts'),
      'utf8',
    );
    const runbook = fs.readFileSync(
      path.join(__dirname, '../../docs/support-admin.md'),
      'utf8',
    );
    for (const source of [script, runbook]) {
      expect(source).not.toMatch(/BEGIN (RSA )?PRIVATE KEY/);
      expect(source).not.toMatch(/firebase-adminsdk/);
      expect(source).not.toMatch(/AIza[0-9A-Za-z_-]{35}/);
      expect(source).not.toMatch(/re_[A-Za-z0-9]{10,}/);
      expect(source).not.toMatch(/"private_key"\s*:\s*"-----/);
    }
    expect(script).toContain('GOOGLE_APPLICATION_CREDENTIALS');
    expect(script).toContain('applicationDefault');
    expect(script).not.toContain('cert(');
  });
});
