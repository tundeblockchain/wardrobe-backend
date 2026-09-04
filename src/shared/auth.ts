import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { Errors } from './errors';

export function getUserId(event: APIGatewayProxyEventV2): string {
  const lambdaSub = event.requestContext.authorizer?.lambda?.sub;
  if (typeof lambdaSub === 'string' && lambdaSub.length > 0) {
    return lambdaSub;
  }

  const jwtSub = event.requestContext.authorizer?.jwt?.claims?.sub;
  if (typeof jwtSub === 'string' && jwtSub.length > 0) {
    return jwtSub;
  }

  throw Errors.unauthenticated();
}
