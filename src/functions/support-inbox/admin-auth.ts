import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { extractBearerToken } from '../../shared/firebase-token';
import {
  verifyFirebaseIdTokenWithClaims,
  type VerifiedFirebaseIdentity,
} from '../../shared/firebase-verify';
import {
  SupportForbiddenError,
  SupportUnauthorizedError,
} from './http';

export type VerifyAdminTokenFn = (
  token: string,
) => Promise<Pick<VerifiedFirebaseIdentity, 'uid' | 'admin'>>;

/**
 * Firebase ID token + custom claim `admin === true` for every admin route.
 * Reuses the same verification helper as the API Gateway authorizer.
 * The claim is checked here in Lambda, not only at API Gateway.
 */
export async function requireSupportAdmin(
  event: APIGatewayProxyEventV2,
  verify: VerifyAdminTokenFn = verifyFirebaseIdTokenWithClaims,
): Promise<Pick<VerifiedFirebaseIdentity, 'uid' | 'admin'>> {
  let token: string;
  try {
    token = extractBearerToken(event);
  } catch {
    throw new SupportUnauthorizedError();
  }

  let identity: Pick<VerifiedFirebaseIdentity, 'uid' | 'admin'>;
  try {
    identity = await verify(token);
  } catch {
    throw new SupportUnauthorizedError();
  }

  if (identity.admin !== true) {
    throw new SupportForbiddenError();
  }
  return identity;
}
