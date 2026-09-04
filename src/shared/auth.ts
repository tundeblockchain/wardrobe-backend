import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { Errors } from './errors';

interface AuthorizerContext {
  lambda?: { sub?: string; userId?: string };
  jwt?: { claims?: { sub?: string; user_id?: string } };
}

/**
 * Return the authenticated Firebase UID.
 *
 * Identity comes only from the API Gateway authorizer context (token `sub`/`uid`).
 * Request body, query, and path `userId` values are never trusted.
 */
export function getUserId(event: APIGatewayProxyEventV2): string {
  const authorizer = (event.requestContext as { authorizer?: AuthorizerContext })
    .authorizer;

  const lambdaSub = firstNonEmpty(
    authorizer?.lambda?.sub,
    authorizer?.lambda?.userId,
  );
  if (lambdaSub) {
    return lambdaSub;
  }

  const jwtSub = firstNonEmpty(
    authorizer?.jwt?.claims?.sub,
    authorizer?.jwt?.claims?.user_id,
  );
  if (jwtSub) {
    return jwtSub;
  }

  throw Errors.unauthenticated();
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}
