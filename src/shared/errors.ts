export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'UNAUTHORIZED'
  | 'VALIDATION_ERROR'
  | 'RATE_LIMITED'
  | 'ORIGIN_NOT_ALLOWED'
  | 'WARDROBE_NOT_FOUND'
  | 'ITEM_NOT_FOUND'
  | 'OUTFIT_NOT_FOUND'
  | 'RENDER_NOT_FOUND'
  | 'AI_PROFILE_NOT_FOUND'
  | 'EVENT_NOT_FOUND'
  | 'SHARE_NOT_FOUND'
  | 'SHARE_GONE'
  | 'UPLOAD_INVALID'
  | 'PROCESSING_FAILED'
  | 'PROCESSING_IN_PROGRESS'
  | 'ITEM_NOT_RETRIABLE'
  | 'ENTITLEMENT_WARDROBE_LIMIT'
  | 'ENTITLEMENT_ITEM_LIMIT'
  | 'ENTITLEMENT_OUTFIT_LIMIT'
  | 'ENTITLEMENT_AI_REQUIRED'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly headers?: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.headers = headers;
  }
}

export const Errors = {
  unauthenticated: (message = 'Authentication required.') =>
    new AppError('UNAUTHENTICATED', message, 401),

  unauthorized: (message = 'You do not have access to this resource.') =>
    new AppError('UNAUTHORIZED', message, 403),

  /** Present-but-invalid Firebase token (WARDROBE-143). Never 403 here. */
  invalidToken: (message = 'Invalid or expired token.') =>
    new AppError('UNAUTHORIZED', message, 401),

  validation: (message: string) =>
    new AppError('VALIDATION_ERROR', message, 400),

  payloadTooLarge: (message = 'Request body is too large.') =>
    new AppError('VALIDATION_ERROR', message, 413),

  rateLimited: (
    retryAfterSeconds: number,
    message = 'Too many requests. Try again later.',
  ) =>
    new AppError('RATE_LIMITED', message, 429, {
      'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))),
    }),

  originNotAllowed: (message = 'Origin is not allowed.') =>
    new AppError('ORIGIN_NOT_ALLOWED', message, 403),

  wardrobeNotFound: (message = 'Wardrobe not found.') =>
    new AppError('WARDROBE_NOT_FOUND', message, 404),

  itemNotFound: (message = 'Clothing item not found.') =>
    new AppError('ITEM_NOT_FOUND', message, 404),

  outfitNotFound: (message = 'Outfit not found.') =>
    new AppError('OUTFIT_NOT_FOUND', message, 404),

  renderNotFound: (message = 'No render has been requested for this outfit.') =>
    new AppError('RENDER_NOT_FOUND', message, 404),

  aiProfileNotFound: (message = 'Virtual profile not found.') =>
    new AppError('AI_PROFILE_NOT_FOUND', message, 404),

  eventNotFound: (message = 'Job event not found.') =>
    new AppError('EVENT_NOT_FOUND', message, 404),

  shareNotFound: (message = 'Share link not found.') =>
    new AppError('SHARE_NOT_FOUND', message, 404),

  /** Expired, revoked, or the underlying item/outfit is gone. */
  shareGone: (message = 'Share link is no longer available.') =>
    new AppError('SHARE_GONE', message, 410),

  uploadInvalid: (message: string) =>
    new AppError('UPLOAD_INVALID', message, 400),

  /** Item already PENDING or PROCESSING — Flutter should keep polling. */
  processingInProgress: (message = 'Item is already processing.') =>
    new AppError('PROCESSING_IN_PROGRESS', message, 409),

  /** READY (or any non-FAILED) item cannot be re-enqueued. */
  itemNotRetriable: (
    message = 'Only FAILED items can be retried.',
  ) => new AppError('ITEM_NOT_RETRIABLE', message, 409),

  /** Free catalog cap — Flutter WARDROBE-90 maps to Superwall Basic. */
  wardrobeLimit: (
    message = 'Free plan allows 1 wardrobe. Upgrade to Basic or Premium.',
  ) => new AppError('ENTITLEMENT_WARDROBE_LIMIT', message, 403),

  itemLimit: (
    message = 'Free plan allows 5 items. Upgrade to Basic or Premium.',
  ) => new AppError('ENTITLEMENT_ITEM_LIMIT', message, 403),

  outfitLimit: (
    message = 'Free plan allows 5 outfits. Upgrade to Basic or Premium.',
  ) => new AppError('ENTITLEMENT_OUTFIT_LIMIT', message, 403),

  /** Try-on and other AI — Flutter WARDROBE-90 maps to Superwall Premium. */
  aiRequired: (
    message = 'Virtual Try On and other AI features require Premium.',
  ) => new AppError('ENTITLEMENT_AI_REQUIRED', message, 403),

  notImplemented: (message = 'This endpoint is not implemented yet.') =>
    new AppError('NOT_IMPLEMENTED', message, 501),

  internal: (message = 'An unexpected error occurred.') =>
    new AppError('INTERNAL_ERROR', message, 500),
};
