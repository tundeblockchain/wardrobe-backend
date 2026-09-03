import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import { errorResponse } from '../../shared/http';
import { Errors } from '../../shared/errors';

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    getUserId(event);
    throw Errors.notImplemented('Clothing item APIs will be added next.');
  } catch (error) {
    return errorResponse(error);
  }
}
