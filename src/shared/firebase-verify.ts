import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { firebaseUidFromPayload } from './firebase-token';

/**
 * Shared Firebase ID-token verification (API Gateway authorizer + in-Lambda
 * checks on public routes such as POST /support/contact).
 *
 * Identity is derived from token claims only — never from a request body.
 */

const secrets = new SecretsManagerClient({});
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
  ),
);

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedProjectId: string | undefined;
let cachedAt = 0;

export async function verifyFirebaseIdToken(token: string): Promise<string> {
  const projectId = await firebaseProjectId();
  const { payload } = await jwtVerify(token, FIREBASE_JWKS, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
    algorithms: ['RS256'],
    clockTolerance: 5,
  });

  const uid = firebaseUidFromPayload(payload);
  if (!uid) {
    throw new Error('Firebase token is missing a user id');
  }
  return uid;
}

export async function firebaseProjectId(): Promise<string> {
  if (cachedProjectId && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedProjectId;
  }

  const secretId = process.env.FIREBASE_PROJECT_ID_SECRET_ARN;
  if (!secretId) {
    throw new Error('FIREBASE_PROJECT_ID_SECRET_ARN is not configured.');
  }

  const result = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  const projectId = parseFirebaseProjectId(result.SecretString);

  cachedProjectId = projectId;
  cachedAt = Date.now();
  return projectId;
}

export function parseFirebaseProjectId(secretString: string | undefined): string {
  if (!secretString) {
    throw new Error('Firebase project ID secret is empty.');
  }

  const trimmed = secretString.trim();
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as { projectId?: unknown };
    if (typeof parsed.projectId === 'string' && parsed.projectId.trim()) {
      return parsed.projectId.trim();
    }
  }

  if (!trimmed) {
    throw new Error('Firebase project ID secret is empty.');
  }

  return trimmed;
}

/** Test-only: clear the in-memory Firebase project ID cache. */
export function resetFirebaseProjectIdCache(): void {
  cachedProjectId = undefined;
  cachedAt = 0;
}
