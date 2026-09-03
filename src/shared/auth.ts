import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { Errors } from './errors';

export function getUserId(event: APIGatewayProxyEventV2): string {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  const sub = claims?.sub;

  if (typeof sub !== 'string' || sub.length === 0) {
    throw Errors.unauthenticated();
  }

  return sub;
}
