import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { extractBearerToken } from '../../shared/firebase-token';
import { verifyFirebaseIdToken } from '../../shared/firebase-verify';
import { SupportUnauthorizedError } from './http';

export type VerifyUserTokenFn = (token: string) => Promise<string>;

/**
 * Firebase ID token for every user support-inbox route. The uid comes from
 * the token (same helper as the API Gateway authorizer). Missing or invalid
 * tokens are 401 {error:"unauthorized"} — never 403.
 */
export async function requireSupportUser(
  event: APIGatewayProxyEventV2,
  verify: VerifyUserTokenFn = verifyFirebaseIdToken,
): Promise<string> {
  let token: string;
  try {
    token = extractBearerToken(event);
  } catch {
    throw new SupportUnauthorizedError();
  }

  try {
    return await verify(token);
  } catch {
    throw new SupportUnauthorizedError();
  }
}
