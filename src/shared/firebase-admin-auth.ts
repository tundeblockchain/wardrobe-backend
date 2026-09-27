import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { Auth, getAuth } from 'firebase-admin/auth';
import { logger } from './logger';
import { getSecretString, parseJsonObjectOrString } from './secrets';
import { looksLikePlaceholderCredential } from './superwall-config';

export interface FirebaseAdminServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export interface FirebaseAdminAuthClient {
  deleteUser(uid: string): Promise<void>;
}

export interface FirebaseAdminAuthDeps {
  getSecretString?: (secretId: string) => Promise<string>;
  getAuth?: () => Promise<FirebaseAdminAuthClient>;
}

const AUTH_USER_NOT_FOUND = 'auth/user-not-found';

let cachedApp: App | undefined;

/**
 * Parse a Firebase Admin service-account JSON from Secrets Manager.
 *
 * Accepts standard Google fields (`project_id`, `client_email`, `private_key`)
 * or camelCase (`projectId`, `clientEmail`, `privateKey`). Never logs the key.
 */
export function parseFirebaseAdminServiceAccount(
  secretString: string,
): FirebaseAdminServiceAccount {
  const parsed = parseJsonObjectOrString(secretString);
  if (typeof parsed === 'string') {
    throw new Error('Firebase Admin secret must be a service-account JSON object.');
  }

  const projectId = firstString(parsed.project_id, parsed.projectId);
  const clientEmail = firstString(parsed.client_email, parsed.clientEmail);
  const privateKey = firstString(parsed.private_key, parsed.privateKey);
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Firebase Admin secret is missing project_id, client_email, or private_key.',
    );
  }
  if (
    looksLikePlaceholderCredential(projectId) ||
    looksLikePlaceholderCredential(clientEmail)
  ) {
    throw new Error('Firebase Admin secret is still a placeholder.');
  }

  return {
    projectId,
    clientEmail,
    privateKey: privateKey.replace(/\\n/g, '\n'),
  };
}

export function isFirebaseAuthUserNotFound(error: unknown): boolean {
  const code = firebaseErrorCode(error);
  return code === AUTH_USER_NOT_FOUND;
}

/**
 * Delete the Firebase Auth user. `auth/user-not-found` is success
 * (already deleted — idempotent retry).
 *
 * Credentials come from `FIREBASE_ADMIN_SECRET_ARN` (Secrets Manager).
 */
export async function deleteFirebaseAuthUser(
  uid: string,
  deps: FirebaseAdminAuthDeps = {},
): Promise<void> {
  const auth = deps.getAuth
    ? await deps.getAuth()
    : await loadAdminAuth(deps);
  try {
    await auth.deleteUser(uid);
  } catch (error) {
    if (isFirebaseAuthUserNotFound(error)) {
      logger.info('Firebase Auth user already absent', { reason: AUTH_USER_NOT_FOUND });
      return;
    }
    throw error;
  }
}

export function resetFirebaseAdminApp(): void {
  cachedApp = undefined;
}

async function loadAdminAuth(
  deps: FirebaseAdminAuthDeps,
): Promise<Auth> {
  if (cachedApp) {
    return getAuth(cachedApp);
  }

  const existing = getApps()[0];
  if (existing) {
    cachedApp = existing;
    return getAuth(existing);
  }

  const account = await loadServiceAccount(deps);
  cachedApp = initializeApp({
    credential: cert({
      projectId: account.projectId,
      clientEmail: account.clientEmail,
      privateKey: account.privateKey,
    }),
  });
  return getAuth(cachedApp);
}

async function loadServiceAccount(
  deps: FirebaseAdminAuthDeps,
): Promise<FirebaseAdminServiceAccount> {
  const secretId = process.env.FIREBASE_ADMIN_SECRET_ARN?.trim();
  if (!secretId) {
    throw new Error('FIREBASE_ADMIN_SECRET_ARN is not configured.');
  }

  const read = deps.getSecretString ?? getSecretString;
  return parseFirebaseAdminServiceAccount(await read(secretId));
}

function firebaseErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const candidate = error as {
    code?: unknown;
    errorInfo?: { code?: unknown };
  };
  if (typeof candidate.code === 'string' && candidate.code.trim()) {
    return candidate.code.trim();
  }
  if (
    typeof candidate.errorInfo?.code === 'string' &&
    candidate.errorInfo.code.trim()
  ) {
    return candidate.errorInfo.code.trim();
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
