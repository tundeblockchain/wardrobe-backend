import * as fs from 'fs';
import * as path from 'path';
import {
  GrantCompPremiumHelpError,
  parseGrantCompPremiumArgs,
  resolveCompPremiumTableName,
  runGrantCompPremium,
  sanitizeErrorMessage,
  usage,
} from '../../scripts/grant-comp-premium';

describe('grant-comp-premium script (WARDROBE-291)', () => {
  const originalTable = process.env.TABLE_NAME;
  const originalStage = process.env.STAGE;

  afterEach(() => {
    if (originalTable === undefined) {
      delete process.env.TABLE_NAME;
    } else {
      process.env.TABLE_NAME = originalTable;
    }
    if (originalStage === undefined) {
      delete process.env.STAGE;
    } else {
      process.env.STAGE = originalStage;
    }
  });

  it('parses uid grant and email grant', () => {
    expect(parseGrantCompPremiumArgs(['--uid', 'firebase-uid-1'])).toEqual({
      uid: 'firebase-uid-1',
      revoke: false,
    });
    expect(
      parseGrantCompPremiumArgs(['--email', 'reviewer@example.com']),
    ).toEqual({
      email: 'reviewer@example.com',
      revoke: false,
    });
  });

  it('parses revoke', () => {
    expect(
      parseGrantCompPremiumArgs(['--uid', 'firebase-uid-1', '--revoke']),
    ).toEqual({
      uid: 'firebase-uid-1',
      revoke: true,
    });
  });

  it('rejects missing identifier and both identifiers', () => {
    expect(() => parseGrantCompPremiumArgs([])).toThrow(/exactly one/);
    expect(() =>
      parseGrantCompPremiumArgs([
        '--uid',
        'firebase-uid-1',
        '--email',
        'reviewer@example.com',
      ]),
    ).toThrow(/exactly one/);
  });

  it('throws a help error that prints usage and exits 0', async () => {
    expect(() => parseGrantCompPremiumArgs(['--help'])).toThrow(
      GrantCompPremiumHelpError,
    );
    const stdout = { write: jest.fn() };
    const stderr = { write: jest.fn() };
    const code = await runGrantCompPremium(['-h'], { stdout, stderr });
    expect(code).toBe(0);
    expect(stdout.write).toHaveBeenCalledWith(`${usage()}\n`);
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('resolves TABLE_NAME like backfill:paid-tier', () => {
    expect(resolveCompPremiumTableName({ TABLE_NAME: 'wardrobe-app-prod' })).toBe(
      'wardrobe-app-prod',
    );
    expect(resolveCompPremiumTableName({ STAGE: 'prod' })).toBe(
      'wardrobe-app-prod',
    );
    expect(resolveCompPremiumTableName({})).toBe('wardrobe-app-dev');
  });

  it('grants via --uid and is idempotent on a second run', async () => {
    const grant = jest
      .fn()
      .mockResolvedValueOnce({ applied: true, idempotent: false })
      .mockResolvedValueOnce({ applied: true, idempotent: true });
    const stdout = { write: jest.fn() };
    const stderr = { write: jest.fn() };

    const first = await runGrantCompPremium(['--uid', 'firebase-uid-1'], {
      grant,
      stdout,
      stderr,
    });
    const second = await runGrantCompPremium(['--uid', 'firebase-uid-1'], {
      grant,
      stdout,
      stderr,
    });

    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(grant).toHaveBeenCalledTimes(2);
    expect(stdout.write.mock.calls[0][0]).toBe(
      `${JSON.stringify({ granted: true, idempotent: false })}\n`,
    );
    expect(stdout.write.mock.calls[1][0]).toBe(
      `${JSON.stringify({ granted: true, idempotent: true })}\n`,
    );
    const output = JSON.stringify(stdout.write.mock.calls);
    expect(output).not.toContain('firebase-uid-1');
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('revokes via --uid', async () => {
    const revoke = jest.fn().mockResolvedValue(undefined);
    const stdout = { write: jest.fn() };
    const code = await runGrantCompPremium(
      ['--uid', 'firebase-uid-1', '--revoke'],
      { revoke, stdout },
    );
    expect(code).toBe(0);
    expect(revoke).toHaveBeenCalledWith('firebase-uid-1');
    expect(stdout.write).toHaveBeenCalledWith(
      `${JSON.stringify({ revoked: true })}\n`,
    );
    expect(String(stdout.write.mock.calls[0][0])).not.toContain('firebase-uid-1');
  });

  it('fails cleanly when --email matches no Firebase user', async () => {
    const email = 'missing-reviewer@example.com';
    const getUserByEmail = jest.fn().mockRejectedValue(
      Object.assign(new Error(`There is no user record for ${email}`), {
        code: 'auth/user-not-found',
      }),
    );
    const stdout = { write: jest.fn() };
    const stderr = { write: jest.fn() };
    const grant = jest.fn();

    const code = await runGrantCompPremium(['--email', email], {
      getUserByEmail,
      grant,
      stdout,
      stderr,
    });

    expect(code).toBe(1);
    expect(grant).not.toHaveBeenCalled();
    expect(stderr.write.mock.calls[0][0]).toMatch(/No Firebase user for --email/);
    expect(JSON.stringify(stderr.write.mock.calls)).not.toContain(email);
    expect(stdout.write).not.toHaveBeenCalled();
  });

  it('redacts email and long identifiers from error text', () => {
    expect(
      sanitizeErrorMessage(
        'lookup failed for reviewer@example.com uid abcdefghijklmnopqrstuvwxyz',
      ),
    ).toBe('lookup failed for [redacted] uid [redacted]');
  });

  it('contains no credentials; operators supply env credentials', () => {
    const script = fs.readFileSync(
      path.join(__dirname, '../../scripts/grant-comp-premium.ts'),
      'utf8',
    );
    expect(script).not.toMatch(/BEGIN (RSA )?PRIVATE KEY/);
    expect(script).not.toMatch(/firebase-adminsdk/);
    expect(script).not.toMatch(/AIza[0-9A-Za-z_-]{35}/);
    expect(script).not.toMatch(/"private_key"\s*:\s*"-----/);
    expect(script).toContain('GOOGLE_APPLICATION_CREDENTIALS');
    expect(script).toContain('applicationDefault');
    expect(script).not.toContain('cert(');
  });
});
