export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'UNAUTHORIZED'
  | 'VALIDATION_ERROR'
  | 'WARDROBE_NOT_FOUND'
  | 'ITEM_NOT_FOUND'
  | 'OUTFIT_NOT_FOUND'
  | 'UPLOAD_INVALID'
  | 'PROCESSING_FAILED'
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

  uploadInvalid: (message: string) =>
    new AppError('UPLOAD_INVALID', message, 400),

  notImplemented: (message = 'This endpoint is not implemented yet.') =>
    new AppError('NOT_IMPLEMENTED', message, 501),

  internal: (message = 'An unexpected error occurred.') =>
    new AppError('INTERNAL_ERROR', message, 500),
};
