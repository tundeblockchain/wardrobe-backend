import { APIGatewayProxyResultV2 } from 'aws-lambda';
import { json } from '../../shared/http';

export function validationResponse(
  fields: Record<string, string>,
): APIGatewayProxyResultV2 {
  return json(400, { error: 'validation', fields });
}

export function rateLimitedResponse(
  retryAfterSeconds: number,
): APIGatewayProxyResultV2 {
  const retryAfter = Math.max(1, Math.ceil(retryAfterSeconds));
  return json(
    429,
    { error: 'rate_limited', retryAfterSeconds: retryAfter },
    { 'Retry-After': String(retryAfter) },
  );
}

export function unauthenticatedResponse(): APIGatewayProxyResultV2 {
  return json(401, { error: 'unauthenticated' });
}

export function unauthorizedResponse(): APIGatewayProxyResultV2 {
  return json(401, { error: 'unauthorized' });
}

export function forbiddenResponse(): APIGatewayProxyResultV2 {
  return json(403, { error: 'forbidden' });
}

export function notFoundResponse(): APIGatewayProxyResultV2 {
  return json(404, { error: 'not_found' });
}

export function notRetryableResponse(): APIGatewayProxyResultV2 {
  return json(409, { error: 'not_retryable' });
}

export function internalErrorResponse(): APIGatewayProxyResultV2 {
  return json(500, { error: 'internal' });
}

export class SupportValidationError extends Error {
  readonly fields: Record<string, string>;

  constructor(fields: Record<string, string>) {
    super('validation');
    this.name = 'SupportValidationError';
    this.fields = fields;
  }
}

export class SupportRateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('rate_limited');
    this.name = 'SupportRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class SupportUnauthenticatedError extends Error {
  constructor() {
    super('unauthenticated');
    this.name = 'SupportUnauthenticatedError';
  }
}

export class SupportUnauthorizedError extends Error {
  constructor() {
    super('unauthorized');
    this.name = 'SupportUnauthorizedError';
  }
}

export class SupportForbiddenError extends Error {
  constructor() {
    super('forbidden');
    this.name = 'SupportForbiddenError';
  }
}

export class SupportNotFoundError extends Error {
  constructor() {
    super('not_found');
    this.name = 'SupportNotFoundError';
  }
}

export class SupportNotRetryableError extends Error {
  constructor() {
    super('not_retryable');
    this.name = 'SupportNotRetryableError';
  }
}
