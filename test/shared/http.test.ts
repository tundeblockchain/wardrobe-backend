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

  it('maps RENDER_NOT_FOUND to a 404 envelope', () => {
    const result = asResult(errorResponse(Errors.renderNotFound()));

    expect(result.statusCode).toBe(404);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'RENDER_NOT_FOUND',
        message: 'No render has been requested for this outfit.',
      },
    });
  });

  it('maps OUTFIT_NOT_FOUND to a 404 envelope', () => {
    const result = asResult(errorResponse(Errors.outfitNotFound()));

    expect(result.statusCode).toBe(404);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'OUTFIT_NOT_FOUND',
        message: 'Outfit not found.',
      },
    });
  });

  it('maps EVENT_NOT_FOUND to a 404 envelope', () => {
    const result = asResult(errorResponse(Errors.eventNotFound()));

    expect(result.statusCode).toBe(404);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'EVENT_NOT_FOUND',
        message: 'Job event not found.',
      },
    });
  });

  it('maps SHARE_NOT_FOUND to a 404 envelope', () => {
    const result = asResult(errorResponse(Errors.shareNotFound()));

    expect(result.statusCode).toBe(404);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'SHARE_NOT_FOUND',
        message: 'Share link not found.',
      },
    });
  });

  it('maps SHARE_GONE to a 410 envelope', () => {
    const result = asResult(errorResponse(Errors.shareGone()));

    expect(result.statusCode).toBe(410);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'SHARE_GONE',
        message: 'Share link is no longer available.',
      },
    });
  });

  it('maps AI_PROFILE_NOT_FOUND to a 404 envelope', () => {
    const result = asResult(errorResponse(Errors.aiProfileNotFound()));

    expect(result.statusCode).toBe(404);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'AI_PROFILE_NOT_FOUND',
        message: 'Virtual Profile not found.',
      },
    });
  });

  it('maps PROCESSING_IN_PROGRESS to a 409 envelope', () => {
    const result = asResult(errorResponse(Errors.processingInProgress()));

    expect(result.statusCode).toBe(409);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'PROCESSING_IN_PROGRESS',
        message: 'Item is already processing.',
      },
    });
  });

  it('maps ITEM_NOT_RETRIABLE to a 409 envelope', () => {
    const result = asResult(errorResponse(Errors.itemNotRetriable()));

    expect(result.statusCode).toBe(409);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'ITEM_NOT_RETRIABLE',
        message: 'Only FAILED items can be retried.',
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

  it('maps ENTITLEMENT_WARDROBE_LIMIT to a 403 envelope', () => {
    const result = asResult(errorResponse(Errors.wardrobeLimit()));

    expect(result.statusCode).toBe(403);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'ENTITLEMENT_WARDROBE_LIMIT',
        message: 'Free plan allows 1 wardrobe. Upgrade to Basic or Premium.',
      },
    });
  });

  it('maps ENTITLEMENT_ITEM_LIMIT to a 403 envelope', () => {
    const result = asResult(errorResponse(Errors.itemLimit()));

    expect(result.statusCode).toBe(403);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'ENTITLEMENT_ITEM_LIMIT',
        message: 'Free plan allows 5 items. Upgrade to Basic or Premium.',
      },
    });
  });

  it('maps ENTITLEMENT_OUTFIT_LIMIT to a 403 envelope', () => {
    const result = asResult(errorResponse(Errors.outfitLimit()));

    expect(result.statusCode).toBe(403);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'ENTITLEMENT_OUTFIT_LIMIT',
        message: 'Free plan allows 5 outfits. Upgrade to Basic or Premium.',
      },
    });
  });

  it('maps ENTITLEMENT_AI_REQUIRED to a 403 envelope', () => {
    const result = asResult(errorResponse(Errors.aiRequired()));

    expect(result.statusCode).toBe(403);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'ENTITLEMENT_AI_REQUIRED',
        message: 'Virtual Try On and other AI features require Premium.',
      },
    });
  });

  it('maps MAIN_IMAGE_REQUIRED to a 400 envelope', () => {
    const result = asResult(errorResponse(Errors.mainImageRequired()));

    expect(result.statusCode).toBe(400);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'MAIN_IMAGE_REQUIRED',
        message: expect.stringContaining('promoteObjectKey'),
      },
    });
  });

  it('maps RATE_LIMITED to a 429 envelope with Retry-After', () => {
    const result = asResult(errorResponse(Errors.rateLimited(17)));

    expect(result.statusCode).toBe(429);
    expect(result.headers?.['Retry-After']).toBe('17');
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Try again later.',
      },
    });
  });

  it('maps ORIGIN_NOT_ALLOWED to a 403 envelope', () => {
    const result = asResult(errorResponse(Errors.originNotAllowed()));

    expect(result.statusCode).toBe(403);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'Origin is not allowed.',
      },
    });
  });

  it('maps invalidToken to a 401 UNAUTHORIZED envelope', () => {
    const result = asResult(errorResponse(Errors.invalidToken()));

    expect(result.statusCode).toBe(401);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or expired token.',
      },
    });
  });

  it('maps ACCOUNT_DELETION_FAILED to a 500 envelope with retryable', () => {
    const result = asResult(errorResponse(Errors.accountDeletionFailed()));

    expect(result.statusCode).toBe(500);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'ACCOUNT_DELETION_FAILED',
        message: 'Account data could not be deleted. Please try again.',
        retryable: true,
      },
    });
  });

  it('maps NOT_STRIPE_PLAN to a 409 envelope with source or null', () => {
    const ios = asResult(errorResponse(Errors.notStripePlan('ios')));
    expect(ios.statusCode).toBe(409);
    expect(bodyOf(ios)).toEqual({
      error: {
        code: 'NOT_STRIPE_PLAN',
        message: 'Manage plan is only available for Stripe subscriptions.',
        source: 'ios',
      },
    });

    const free = asResult(errorResponse(Errors.notStripePlan(null)));
    expect(free.statusCode).toBe(409);
    expect(bodyOf(free)).toEqual({
      error: {
        code: 'NOT_STRIPE_PLAN',
        message: 'Manage plan is only available for Stripe subscriptions.',
        source: null,
      },
    });
  });

  it('maps INVALID_INTERVAL to a 400 envelope', () => {
    const result = asResult(errorResponse(Errors.invalidInterval()));

    expect(result.statusCode).toBe(400);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'INVALID_INTERVAL',
        message: 'interval must be "monthly" or "yearly".',
      },
    });
  });

  it('maps BILLING_PRICE_NOT_FOUND to a 503 envelope', () => {
    const result = asResult(errorResponse(Errors.billingPriceNotFound()));

    expect(result.statusCode).toBe(503);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'BILLING_PRICE_NOT_FOUND',
        message: 'The requested billing plan is not available.',
      },
    });
  });

  it('maps ALREADY_SUBSCRIBED to a 409 envelope and adds source', () => {
    const result = asResult(errorResponse(Errors.alreadySubscribed('ios')));

    expect(result.statusCode).toBe(409);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'ALREADY_SUBSCRIBED',
        message: 'This account already has a paid plan.',
        source: 'ios',
      },
    });
  });

  it('maps BILLING_CANCEL_FAILED to a 503 envelope with retryable', () => {
    const result = asResult(errorResponse(Errors.billingCancelFailed()));

    expect(result.statusCode).toBe(503);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'BILLING_CANCEL_FAILED',
        message: 'The Stripe subscription could not be canceled. Please try again.',
        retryable: true,
      },
    });
  });

  it('maps AUTH_DELETION_FAILED to a 502 envelope with retryable', () => {
    const result = asResult(errorResponse(Errors.authDeletionFailed()));

    expect(result.statusCode).toBe(502);
    expect(bodyOf(result)).toEqual({
      error: {
        code: 'AUTH_DELETION_FAILED',
        message:
          'Account data was removed but the auth user could not be deleted. Please try again.',
        retryable: true,
      },
    });
  });
});
