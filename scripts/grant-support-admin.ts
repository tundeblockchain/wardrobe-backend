/**
 * Grant or revoke the Firebase custom claim `admin: true` for support inbox
 * operators (WARDROBE-284).
 *
 * Credentials come from the operator's environment
 * (`GOOGLE_APPLICATION_CREDENTIALS` pointing at a local service-account JSON).
 * This repository never stores Firebase private keys or service-account files.
 *
 * After a change, the user must sign out and sign in (or refresh the ID
 * token) before the claim appears on API requests.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json npm run support:grant-admin -- --uid <firebaseUid>
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json npm run support:grant-admin -- --email <email>
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json npm run support:grant-admin -- --uid <firebaseUid> --revoke
 */

import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export interface GrantSupportAdminArgs {
  uid?: string;
  email?: string;
  revoke: boolean;
}

export function parseGrantSupportAdminArgs(argv: string[]): GrantSupportAdminArgs {
  let uid: string | undefined;
  let email: string | undefined;
  let revoke = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--revoke') {
      revoke = true;
      continue;
    }
    if (arg === '--uid') {
      uid = nextValue(argv, i, '--uid');
      i += 1;
      continue;
    }
    if (arg === '--email') {
      email = nextValue(argv, i, '--email');
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      throw new Error(usage());
    }
    throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }

  const trimmedUid = uid?.trim();
  const trimmedEmail = email?.trim();
  if (Boolean(trimmedUid) === Boolean(trimmedEmail)) {
    throw new Error(`Provide exactly one of --uid or --email.\n${usage()}`);
  }

  return {
    ...(trimmedUid ? { uid: trimmedUid } : {}),
    ...(trimmedEmail ? { email: trimmedEmail } : {}),
    revoke,
  };
}

/**
 * Merge `admin: true` onto existing custom claims, or remove it.
 * Other claims are preserved.
 */
export function nextAdminCustomClaims(
  existing: Record<string, unknown> | undefined,
  admin: boolean,
): Record<string, unknown> {
  const claims: Record<string, unknown> = { ...(existing ?? {}) };
  if (admin) {
    claims.admin = true;
  } else {
    delete claims.admin;
  }
  return claims;
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.\n${usage()}`);
  }
  return value;
}

function usage(): string {
  return [
    'Usage:',
    '  npm run support:grant-admin -- --uid <firebaseUid>',
    '  npm run support:grant-admin -- --email <email>',
    '  npm run support:grant-admin -- --uid <firebaseUid> --revoke',
    '',
    'Requires GOOGLE_APPLICATION_CREDENTIALS in the operator environment.',
  ].join('\n');
}

async function main(): Promise<void> {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    throw new Error(
      'GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at a local Firebase service-account JSON. Do not commit that file.',
    );
  }

  const args = parseGrantSupportAdminArgs(process.argv.slice(2));
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault() });
  }
  const auth = getAuth();
  const user = args.uid
    ? await auth.getUser(args.uid)
    : await auth.getUserByEmail(args.email as string);

  const claims = nextAdminCustomClaims(user.customClaims, !args.revoke);
  await auth.setCustomUserClaims(user.uid, claims);

  process.stdout.write(
    `${JSON.stringify({
      uid: user.uid,
      admin: claims.admin === true,
      revoke: args.revoke,
    })}\n`,
  );
  process.stdout.write(
    'Sign out and sign in (or refresh the ID token) before calling admin routes.\n',
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`grant-support-admin failed: ${message}\n`);
    process.exitCode = 1;
  });
}
