import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ok } from '../../shared/http';

export async function handler(
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  return ok({
    status: 'ok',
    service: 'wardrobe-backend',
    timestamp: new Date().toISOString(),
  });
}
