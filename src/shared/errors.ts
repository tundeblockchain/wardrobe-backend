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
  | 'MAIN_IMAGE_REQUIRED'
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
  | 'INTERNAL_ERROR'
  | 'ACCOUNT_DELETION_FAILED'
  | 'AUTH_DELETION_FAILED'
  | 'ALREADY_SUBSCRIBED'
  | 'NOT_STRIPE_PLAN'
  | 'INVALID_INTERVAL'
  | 'BILLING_PRICE_NOT_FOUND'
  | 'BILLING_NOT_CONFIGURED'
  | 'BILLING_CANCEL_FAILED'
  | 'PLANS_UNAVAILABLE';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly headers?: Record<string, string>;
  readonly retryable?: boolean;
  /**
   * Present on `ALREADY_SUBSCRIBED` when the paid-tier source is known.
   * `NOT_STRIPE_PLAN` always sets this: `ios` | `android` | `stripe`, or
   * `null` when the effective plan is Free.
   */
  readonly source?: string | null;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    headers?: Record<string, string>,
    retryable?: boolean,
    source?: string | null,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.headers = headers;
    if (retryable !== undefined) {
      this.retryable = retryable;
    }
    if (source !== undefined) {
      this.source = source;
    }
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

  aiProfileNotFound: (message = 'Virtual Profile not found.') =>
    new AppError('AI_PROFILE_NOT_FOUND', message, 404),

  /**
   * Deleting the main Virtual Profile photo while two or more others remain
   * (WARDROBE-157). Flutter must send `promoteObjectKey`.
   */
  mainImageRequired: (
    message = 'promoteObjectKey is required when deleting the main Virtual Profile photo while other photos remain.',
  ) => new AppError('MAIN_IMAGE_REQUIRED', message, 400),

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

  /**
   * Dynamo / S3 (or other AWS data) step failed on DELETE /me.
   * Safe to retry — Auth user is not deleted until data is gone.
   */
  accountDeletionFailed: (
    message = 'Account data could not be deleted. Please try again.',
  ) => new AppError('ACCOUNT_DELETION_FAILED', message, 500, undefined, true),

  /**
   * AWS data is gone but Firebase Auth user delete failed.
   * Safe to retry — the next call skips empty data and retries Auth.
   */
  authDeletionFailed: (
    message = 'Account data was removed but the auth user could not be deleted. Please try again.',
  ) => new AppError('AUTH_DELETION_FAILED', message, 502, undefined, true),

  /**
   * Account already has a paid plan from any source (WARDROBE-189).
   * `source` is ios | android | stripe when known.
   */
  alreadySubscribed: (
    source?: string,
    message = 'This account already has a paid plan.',
  ) => new AppError('ALREADY_SUBSCRIBED', message, 409, undefined, undefined, source),

  /**
   * Checkout `interval` is present but not `"monthly"` | `"yearly"`
   * (WARDROBE-196). Includes non-string values.
   */
  invalidInterval: (
    message = 'interval must be "monthly" or "yearly".',
  ) => new AppError('INVALID_INTERVAL', message, 400),

  /**
   * Checkout Price lookup key (or pinned id) is missing in Stripe
   * (WARDROBE-196). Yearly prices are created in the dashboard, not
   * by `stripe:seed`. Do not include Stripe ids or secrets.
   */
  billingPriceNotFound: (
    message = 'The requested billing plan is not available.',
  ) => new AppError('BILLING_PRICE_NOT_FOUND', message, 503),

  /**
   * Public GET /billing/plans cannot resolve the four catalog prices
   * (WARDROBE-207). Stripe unconfigured, placeholder secret, or a
   * missing / inactive lookup key. Do not include Stripe ids or secrets.
   */
  plansUnavailable: (
    message = 'Billing plans are temporarily unavailable.',
  ) => new AppError('PLANS_UNAVAILABLE', message, 503),

  /**
   * Stripe return origin is missing or not https (WARDROBE-198).
   * Do not default to a Netlify (or any other) domain.
   */
  billingNotConfigured: (
    message = 'Billing return URL is not configured.',
  ) => new AppError('BILLING_NOT_CONFIGURED', message, 503),

  /**
   * Portal is Stripe-only (WARDROBE-191). `source` is the current
   * `paidTier.source`, or `null` when the effective plan is Free.
   */
  notStripePlan: (
    source: string | null,
    message = 'Manage plan is only available for Stripe subscriptions.',
  ) => new AppError('NOT_STRIPE_PLAN', message, 409, undefined, undefined, source),

  /**
   * Stripe cancel failed on DELETE /me (WARDROBE-192). Account data and
   * Auth stay so a retry cannot leave a paying subscription behind.
   */
  billingCancelFailed: (
    message = 'The Stripe subscription could not be canceled. Please try again.',
  ) => new AppError('BILLING_CANCEL_FAILED', message, 503, undefined, true),
};
