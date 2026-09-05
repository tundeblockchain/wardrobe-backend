/**
 * Worker-side errors. Permanent failures are acked (optionally after
 * FAILED). Retryable failures are reported to SQS so the message is
 * redelivered and can land on the DLQ after maxReceiveCount (3).
 */

export class PermanentProcessingError extends Error {
  readonly retryable = false as const;

  constructor(message: string) {
    super(message);
    this.name = 'PermanentProcessingError';
  }
}

export class RetryableProcessingError extends Error {
  readonly retryable = true as const;

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'RetryableProcessingError';
  }
}

const RETRYABLE_ERROR_NAMES = new Set([
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'InternalServerError',
  'ServiceUnavailable',
  'ServiceUnavailableException',
  'TimeoutError',
  'RequestTimeout',
  'NetworkingError',
  'TooManyRequestsException',
]);

function awsHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const metadata = (error as { $metadata?: { httpStatusCode?: number } })
    .$metadata;
  return metadata?.httpStatusCode;
}

export function isRetryableProcessingFailure(error: unknown): boolean {
  if (error instanceof PermanentProcessingError) {
    return false;
  }
  if (error instanceof RetryableProcessingError) {
    return true;
  }
  if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
    return false;
  }

  if (error instanceof Error && RETRYABLE_ERROR_NAMES.has(error.name)) {
    return true;
  }

  const status = awsHttpStatus(error);
  if (status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }

  // Unexpected failures during valid work: retry so SQS can DLQ them.
  return true;
}
