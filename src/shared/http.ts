import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { AppError, Errors } from './errors';
import { logger } from './logger';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
};

export function json(
  statusCode: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

export function ok<T>(body: T): APIGatewayProxyResultV2 {
  return json(200, body);
}

export function created<T>(body: T): APIGatewayProxyResultV2 {
  return json(201, body);
}

export function accepted<T>(body: T): APIGatewayProxyResultV2 {
  return json(202, body);
}

export function noContent(): APIGatewayProxyResultV2 {
  return {
    statusCode: 204,
    headers: CORS_HEADERS,
    body: '',
  };
}

export function errorResponse(error: unknown): APIGatewayProxyResultV2 {
  if (error instanceof AppError) {
    return json(
      error.statusCode,
      {
        error: {
          code: error.code,
          message: error.message,
        },
      },
      error.headers,
    );
  }

  logger.error('Unhandled error', { error: toSafeError(error) });

  return json(500, {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    },
  });
}

export const MAX_SUPPORT_BODY_BYTES = 16 * 1024;

export function rawBodyByteLength(event: APIGatewayProxyEventV2): number {
  if (!event.body) {
    return 0;
  }
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, 'base64').byteLength;
  }
  return Buffer.byteLength(event.body, 'utf8');
}

export function assertBodyWithinLimit(
  event: APIGatewayProxyEventV2,
  maxBytes = MAX_SUPPORT_BODY_BYTES,
): void {
  if (rawBodyByteLength(event) > maxBytes) {
    throw Errors.payloadTooLarge(
      `Request body must be ${maxBytes} bytes or fewer.`,
    );
  }
}

export function parseJsonBody<T>(event: APIGatewayProxyEventV2): T {
  if (!event.body) {
    throw Errors.validation('Request body is required.');
  }

  try {
    return JSON.parse(decodeEventBody(event)) as T;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw Errors.validation('Request body must be valid JSON.');
  }
}

function decodeEventBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) {
    return '';
  }
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, 'base64').toString('utf8');
  }
  return event.body;
}

/** Empty / missing body becomes `{}`. Invalid JSON still fails. */
export function parseOptionalJsonBody<T>(event: APIGatewayProxyEventV2): T {
  if (!event.body || event.body.trim() === '') {
    return {} as T;
  }
  return parseJsonBody<T>(event);
}

export function requirePathParam(
  event: APIGatewayProxyEventV2,
  name: string,
): string {
  const value = event.pathParameters?.[name];
  if (!value) {
    throw Errors.validation(`Path parameter "${name}" is required.`);
  }
  return value;
}

export function routeKey(event: APIGatewayProxyEventV2): string {
  const method = event.requestContext.http.method;
  const path = event.routeKey?.includes('{')
    ? event.routeKey
    : `${method} ${event.rawPath}`;
  return event.routeKey ?? path;
}

function toSafeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'UnknownError', message: 'Unknown error' };
}
