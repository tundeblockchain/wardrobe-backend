import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { bucketName } from '../../shared/s3';
import { SUPPORT_SCREENSHOT_MAX_BYTES } from '../../shared/support-inbox-names';
import { SupportValidationError } from './http';
import { isSafeSupportObjectKey } from './validation';

const s3 = new S3Client({});

export interface HeadScreenshotResult {
  contentLength?: number;
}

export type HeadScreenshotFn = (
  screenshotKey: string,
) => Promise<HeadScreenshotResult>;

export async function headSupportScreenshot(
  screenshotKey: string,
): Promise<HeadScreenshotResult> {
  const result = await s3.send(
    new HeadObjectCommand({
      Bucket: bucketName(),
      Key: screenshotKey,
    }),
  );
  return { contentLength: result.ContentLength };
}

export async function assertSupportScreenshot(
  screenshotKey: string,
  head: HeadScreenshotFn = headSupportScreenshot,
): Promise<void> {
  if (!isSafeSupportObjectKey(screenshotKey)) {
    throw new SupportValidationError({
      screenshotKey: 'must be a support/ object key',
    });
  }

  let meta: HeadScreenshotResult;
  try {
    meta = await head(screenshotKey);
  } catch (error) {
    if (isNotFound(error)) {
      throw new SupportValidationError({
        screenshotKey: 'must exist under support/ and be 5 MB or smaller',
      });
    }
    throw error;
  }

  const size = meta.contentLength;
  if (
    typeof size !== 'number' ||
    !Number.isFinite(size) ||
    size < 1 ||
    size > SUPPORT_SCREENSHOT_MAX_BYTES
  ) {
    throw new SupportValidationError({
      screenshotKey: 'must exist under support/ and be 5 MB or smaller',
    });
  }
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const named = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (named.name === 'NotFound' || named.name === 'NoSuchKey') {
    return true;
  }
  return named.$metadata?.httpStatusCode === 404;
}
