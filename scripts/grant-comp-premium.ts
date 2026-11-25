/**
 * Grant or revoke a dedicated, non-expiring COMP Premium entitlement
 * (WARDROBE-291). Writes `USER#{uid} / ENTITLEMENT#COMP` rather than
 * editing the store entitlement row.
 *
 *   STAGE=prod npm run premium:grant -- --uid <firebaseUid>
 *   STAGE=prod npm run premium:grant -- --email <email>
 *   STAGE=prod npm run premium:grant -- --uid <firebaseUid> --revoke
 *
 * PowerShell strips `--` from `npm run`, so call ts-node directly:
 *
 *   $env:STAGE="prod"
 *   npx ts-node --transpile-only scripts/grant-comp-premium.ts --uid <uid>
 *
 * `--email` resolves to a Firebase uid the same way `support:grant-admin`
 * does (`GOOGLE_APPLICATION_CREDENTIALS`). `--uid` only needs AWS access
 * to the Dynamo table. This repository never stores Firebase private keys
 * or service-account files.
 *
 * Logs no email and no full uid.
 */

import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import {
  grantCompPremium,
  revokeCompPremium,
} from '../src/shared/entitlements';
import { isFirebaseAuthUserNotFound } from '../src/shared/firebase-admin-auth';

export interface GrantCompPremiumArgs {
  uid?: string;
  email?: string;
  revoke: boolean;
}

export class GrantCompPremiumHelpError extends Error {
  constructor() {
    super(usage());
    this.name = 'GrantCompPremiumHelpError';
  }
}

export class GrantCompPremiumUserNotFoundError extends Error {
  constructor() {
    super('No Firebase user for --email.');
    this.name = 'GrantCompPremiumUserNotFoundError';
  }
}

export function parseGrantCompPremiumArgs(argv: string[]): GrantCompPremiumArgs {
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
      throw new GrantCompPremiumHelpError();
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

export function resolveCompPremiumTableName(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TABLE_NAME?.trim()) {
    return env.TABLE_NAME.trim();
  }
  const stage = env.STAGE?.trim() || 'dev';
  return `wardrobe-app-${stage}`;
}

export function usage(): string {
  return [
    'Usage:',
    '  npm run premium:grant -- --uid <firebaseUid>',
    '  npm run premium:grant -- --email <email>',
    '  npm run premium:grant -- --uid <firebaseUid> --revoke',
    '',
    'PowerShell (npm run strips --):',
    '  $env:STAGE="prod"',
    '  npx ts-node --transpile-only scripts/grant-comp-premium.ts --uid <uid>',
    '',
    'Table: TABLE_NAME, or wardrobe-app-${STAGE} (STAGE defaults to dev).',
    '--email requires GOOGLE_APPLICATION_CREDENTIALS in the operator environment.',
  ].join('\n');
}

export interface GrantCompPremiumDeps {
  getUserByEmail?: (email: string) => Promise<{ uid: string }>;
  grant?: typeof grantCompPremium;
  revoke?: typeof revokeCompPremium;
  stdout?: { write: (chunk: string) => void };
  stderr?: { write: (chunk: string) => void };
}

async function resolveUid(
  args: GrantCompPremiumArgs,
  deps: GrantCompPremiumDeps,
): Promise<string> {
  if (args.uid) {
    return args.uid;
  }

  const email = args.email as string;
  if (deps.getUserByEmail) {
    try {
      return (await deps.getUserByEmail(email)).uid;
    } catch (error: unknown) {
      if (isEmailLookupMiss(error)) {
        throw new GrantCompPremiumUserNotFoundError();
      }
      throw error;
    }
  }

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    throw new Error(
      'GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at a local Firebase service-account JSON. Do not commit that file.',
    );
  }
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault() });
  }
  try {
    const user = await getAuth().getUserByEmail(email);
    return user.uid;
  } catch (error: unknown) {
    if (isEmailLookupMiss(error)) {
      throw new GrantCompPremiumUserNotFoundError();
    }
    throw error;
  }
}

function isEmailLookupMiss(error: unknown): boolean {
  if (isFirebaseAuthUserNotFound(error)) {
    return true;
  }
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  return code === 'auth/user-not-found' || code === 'user-not-found';
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.\n${usage()}`);
  }
  return value;
}

export async function runGrantCompPremium(
  argv: string[],
  deps: GrantCompPremiumDeps = {},
): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;

  let args: GrantCompPremiumArgs;
  try {
    args = parseGrantCompPremiumArgs(argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof GrantCompPremiumHelpError) {
      out.write(`${message}\n`);
      return 0;
    }
    err.write(`grant-comp-premium failed: ${message}\n`);
    return 1;
  }

  process.env.TABLE_NAME = resolveCompPremiumTableName();

  try {
    const uid = await resolveUid(args, deps);
    if (args.revoke) {
      await (deps.revoke ?? revokeCompPremium)(uid);
      out.write(`${JSON.stringify({ revoked: true })}\n`);
      return 0;
    }
    const result = await (deps.grant ?? grantCompPremium)(uid);
    out.write(
      `${JSON.stringify({ granted: true, idempotent: result.idempotent })}\n`,
    );
    return 0;
  } catch (error: unknown) {
    if (error instanceof GrantCompPremiumUserNotFoundError) {
      err.write(`grant-comp-premium failed: ${error.message}\n`);
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    err.write(`grant-comp-premium failed: ${sanitizeErrorMessage(message)}\n`);
    return 1;
  }
}

/** Drop emails and long identifier-looking tokens from operator errors. */
export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
}

async function main(): Promise<void> {
  const code = await runGrantCompPremium(process.argv.slice(2));
  process.exitCode = code;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `grant-comp-premium failed: ${sanitizeErrorMessage(message)}\n`,
    );
    process.exitCode = 1;
  });
}
