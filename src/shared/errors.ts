export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'UNAUTHORIZED'
  | 'VALIDATION_ERROR'
  | 'WARDROBE_NOT_FOUND'
  | 'ITEM_NOT_FOUND'
  | 'OUTFIT_NOT_FOUND'
  | 'RENDER_NOT_FOUND'
  | 'AI_PROFILE_NOT_FOUND'
  | 'UPLOAD_INVALID'
  | 'PROCESSING_FAILED'
  | 'ENTITLEMENT_WARDROBE_LIMIT'
  | 'ENTITLEMENT_ITEM_LIMIT'
  | 'ENTITLEMENT_OUTFIT_LIMIT'
  | 'ENTITLEMENT_AI_REQUIRED'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;

  constructor(code: ErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const Errors = {
  unauthenticated: (message = 'Authentication required.') =>
    new AppError('UNAUTHENTICATED', message, 401),

  unauthorized: (message = 'You do not have access to this resource.') =>
    new AppError('UNAUTHORIZED', message, 403),

  validation: (message: string) =>
    new AppError('VALIDATION_ERROR', message, 400),

  wardrobeNotFound: (message = 'Wardrobe not found.') =>
    new AppError('WARDROBE_NOT_FOUND', message, 404),

  itemNotFound: (message = 'Clothing item not found.') =>
    new AppError('ITEM_NOT_FOUND', message, 404),

  outfitNotFound: (message = 'Outfit not found.') =>
    new AppError('OUTFIT_NOT_FOUND', message, 404),

  renderNotFound: (message = 'No render has been requested for this outfit.') =>
    new AppError('RENDER_NOT_FOUND', message, 404),

  aiProfileNotFound: (message = 'AI profile not found.') =>
    new AppError('AI_PROFILE_NOT_FOUND', message, 404),

  uploadInvalid: (message: string) =>
    new AppError('UPLOAD_INVALID', message, 400),

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
    message = 'AI Try On and other AI features require Premium.',
  ) => new AppError('ENTITLEMENT_AI_REQUIRED', message, 403),

  notImplemented: (message = 'This endpoint is not implemented yet.') =>
    new AppError('NOT_IMPLEMENTED', message, 501),

  internal: (message = 'An unexpected error occurred.') =>
    new AppError('INTERNAL_ERROR', message, 500),
};
