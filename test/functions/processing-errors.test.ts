import {
  isRetryableProcessingFailure,
  PermanentProcessingError,
  RetryableProcessingError,
} from '../../src/functions/processing/errors';

describe('processing error classification (WARDROBE-17)', () => {
  it('treats PermanentProcessingError as non-retryable (ack / FAILED)', () => {
    expect(isRetryableProcessingFailure(new PermanentProcessingError('bad image'))).toBe(
      false,
    );
  });

  it('treats RetryableProcessingError as retryable (SQS redelivery → DLQ)', () => {
    expect(isRetryableProcessingFailure(new RetryableProcessingError('throttled'))).toBe(
      true,
    );
  });

  it('treats ConditionalCheckFailedException as non-retryable', () => {
    const error = new Error('The conditional request failed');
    error.name = 'ConditionalCheckFailedException';
    expect(isRetryableProcessingFailure(error)).toBe(false);
  });

  it('treats DynamoDB throttles and 5xx as retryable', () => {
    const throttle = new Error('throttled');
    throttle.name = 'ThrottlingException';
    expect(isRetryableProcessingFailure(throttle)).toBe(true);

    const server = new Error('boom');
    (server as { $metadata?: { httpStatusCode?: number } }).$metadata = {
      httpStatusCode: 503,
    };
    expect(isRetryableProcessingFailure(server)).toBe(true);
  });

  it('retries unexpected errors so they can reach the DLQ', () => {
    expect(isRetryableProcessingFailure(new Error('mystery'))).toBe(true);
  });
});
