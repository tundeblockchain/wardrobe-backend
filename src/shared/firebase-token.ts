/**
 * Pure Firebase ID-token helpers used by the API Gateway Lambda authorizer.
 * Identity is derived from token claims only — never from a request body.
 */

export interface FirebaseTokenClaims {
  sub?: unknown;
  uid?: unknown;
  user_id?: unknown;
}

export function extractBearerToken(event: {
  headers?: Record<string, string | undefined> | null;
  identitySource?: string[];
}): string {
  const header =
    event.headers?.authorization ??
    event.headers?.Authorization ??
    event.identitySource?.[0];

  if (typeof header !== 'string' || header.trim().length === 0) {
    throw new Error('Missing Authorization header');
  }

  const match = header.trim().match(/^Bearer\s+(\S.*)$/i);
  const token = match?.[1]?.trim();
  if (!token) {
    throw new Error('Authorization header must be a Bearer token');
  }

  return token;
}

/**
 * Firebase ID tokens expose the UID as `user_id` and `sub`.
 * Some decoded representations also include `uid`.
 */
export function firebaseUidFromPayload(
  payload: FirebaseTokenClaims,
): string | undefined {
  for (const value of [payload.uid, payload.user_id, payload.sub]) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}
