import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import { Errors } from '../../shared/errors';
import { errorResponse } from '../../shared/http';

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    getUserId(event);
    throw Errors.notImplemented('Outfit APIs will be added next.');
  } catch (error) {
    return errorResponse(error);
  }
}
