import {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from 'aws-lambda';
import { extractBearerToken } from '../../shared/firebase-token';
import {
  resetFirebaseProjectIdCache,
  verifyFirebaseIdToken,
} from '../../shared/firebase-verify';
import { logger } from '../../shared/logger';

interface AuthorizerContext {
  sub: string;
}

export async function handler(
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<APIGatewaySimpleAuthorizerWithContextResult<AuthorizerContext>> {
  try {
    const token = extractBearerToken(event);
    const uid = await verifyFirebaseIdToken(token);

    return {
      isAuthorized: true,
      context: { sub: uid },
    };
  } catch (error) {
    logger.warn('Firebase token validation failed', {
      error: error instanceof Error ? error.name : 'UnknownError',
    });
    return deny();
  }
}

function deny(): APIGatewaySimpleAuthorizerWithContextResult<AuthorizerContext> {
  return { isAuthorized: false, context: { sub: '' } };
}

/** Test-only: clear the in-memory Firebase project ID cache. */
export function resetAuthorizerCache(): void {
  resetFirebaseProjectIdCache();
}
