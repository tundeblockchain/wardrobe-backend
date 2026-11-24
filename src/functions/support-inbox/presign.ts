import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { Errors } from '../../shared/errors';
import { newUploadId } from '../../shared/ids';
import { bucketName } from '../../shared/s3';
import {
  SUPPORT_KEY_PREFIX,
  SUPPORT_PRESIGN_EXPIRES_SECONDS,
  SUPPORT_SCREENSHOT_MAX_BYTES,
  type SupportUploadContentType,
} from '../../shared/support-inbox-names';

const s3 = new S3Client({});

const EXTENSION_BY_CONTENT_TYPE: Record<SupportUploadContentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

export type CreatePresignedPostFn = typeof createPresignedPost;

export function supportPresignConditions(
  contentType: SupportUploadContentType,
): Array<['content-length-range', number, number] | ['eq', string, string]> {
  return [
    ['content-length-range', 1, SUPPORT_SCREENSHOT_MAX_BYTES],
    ['eq', '$Content-Type', contentType],
  ];
}

export function supportScreenshotObjectKey(
  contentType: SupportUploadContentType,
  uploadId: string = newUploadId(),
): string {
  const extension = EXTENSION_BY_CONTENT_TYPE[contentType];
  return `${SUPPORT_KEY_PREFIX}${uploadId}.${extension}`;
}

export async function createSupportUploadPost(params: {
  contentType: SupportUploadContentType;
  createPost?: CreatePresignedPostFn;
  objectKey?: string;
  expiresIn?: number;
}): Promise<{
  url: string;
  fields: Record<string, string>;
  screenshotKey: string;
}> {
  const bucket = bucketName();
  const screenshotKey =
    params.objectKey ?? supportScreenshotObjectKey(params.contentType);
  const expiresIn = params.expiresIn ?? SUPPORT_PRESIGN_EXPIRES_SECONDS;
  const createPost = params.createPost ?? createPresignedPost;

  const result = await createPost(s3, {
    Bucket: bucket,
    Key: screenshotKey,
    Conditions: supportPresignConditions(params.contentType),
    Fields: {
      'Content-Type': params.contentType,
    },
    Expires: expiresIn,
  });

  if (!result.url || !result.fields) {
    throw Errors.internal('Failed to create a support upload URL.');
  }

  return {
    url: result.url,
    fields: result.fields,
    screenshotKey,
  };
}
