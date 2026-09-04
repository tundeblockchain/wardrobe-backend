import { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { Errors } from '../../src/shared/errors';
import { errorResponse } from '../../src/shared/http';

function asResult(
  result: ReturnType<typeof errorResponse>,
): APIGatewayProxyStructuredResultV2 {
  if (typeof result === 'string') {
    throw new Error('expected a structured API Gateway result');
  }
  return result;
}

function bodyOf(result: APIGatewayProxyStructuredResultV2): unknown {
  return JSON.parse(result.body ?? '{}');
}

describe('shared error envelope', () => {
  it('maps UNAUTHENTICATED to a 401 envelope', () => {
    const result = asResult(errorResponse(Errors.unauthenticated()));

    expect(result.statusCode).toBe(401);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Authentication required.',
      },
    });
  });

  it('maps UNAUTHORIZED to a 403 envelope', () => {
    const result = asResult(errorResponse(Errors.unauthorized()));

    expect(result.statusCode).toBe(403);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'You do not have access to this resource.',
      },
    });
  });
});
