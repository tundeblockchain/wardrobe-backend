import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { Errors } from './errors';

interface AuthorizerContext {
  lambda?: { sub?: string };
  jwt?: { claims?: { sub?: string } };
}

export function getUserId(event: APIGatewayProxyEventV2): string {
  const authorizer = (event.requestContext as { authorizer?: AuthorizerContext }).authorizer;

  const lambdaSub = authorizer?.lambda?.sub;
  if (typeof lambdaSub === 'string' && lambdaSub.length > 0) {
    return lambdaSub;
  }

  const jwtSub = authorizer?.jwt?.claims?.sub;
  if (typeof jwtSub === 'string' && jwtSub.length > 0) {
    return jwtSub;
  }

  throw Errors.unauthenticated();
}
