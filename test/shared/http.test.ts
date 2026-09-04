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

  it('maps VALIDATION_ERROR to a 400 envelope', () => {
    const result = asResult(errorResponse(Errors.validation('name is required.')));

    expect(result.statusCode).toBe(400);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'name is required.',
      },
    });
  });

  it('maps WARDROBE_NOT_FOUND to a 404 envelope', () => {
    const result = asResult(errorResponse(Errors.wardrobeNotFound()));

    expect(result.statusCode).toBe(404);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'WARDROBE_NOT_FOUND',
        message: 'Wardrobe not found.',
      },
    });
  });

  it('maps ITEM_NOT_FOUND to a 404 envelope', () => {
    const result = asResult(errorResponse(Errors.itemNotFound()));

    expect(result.statusCode).toBe(404);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'ITEM_NOT_FOUND',
        message: 'Clothing item not found.',
      },
    });
  });

  it('maps UPLOAD_INVALID to a 400 envelope', () => {
    const result = asResult(
      errorResponse(Errors.uploadInvalid('purpose must be WARDROBE_ITEM.')),
    );

    expect(result.statusCode).toBe(400);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'UPLOAD_INVALID',
        message: 'purpose must be WARDROBE_ITEM.',
      },
    });
  });
});
