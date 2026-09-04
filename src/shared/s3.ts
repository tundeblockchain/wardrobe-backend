import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Errors } from './errors';

const s3 = new S3Client({});

export const ALLOWED_CONTENT_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

/** MVP max object size for wardrobe item photos (10 MiB). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const PRESIGNED_URL_EXPIRES_IN = 900;

export function bucketName(): string {
  const name = process.env.MEDIA_BUCKET_NAME;
  if (!name) {
    throw Errors.internal('MEDIA_BUCKET_NAME is not configured.');
  }
  return name;
}

export function normalizeContentType(contentType: string): string {
  return contentType.trim().toLowerCase();
}

export function extensionForContentType(contentType: string): string {
  const extension = ALLOWED_CONTENT_TYPES[normalizeContentType(contentType)];
  if (!extension) {
    throw Errors.uploadInvalid(
      'Unsupported content type. Use image/jpeg, image/png, image/webp, or image/heic.',
    );
  }
  return extension;
}

export function assertUploadContentLength(contentLength: number): number {
  if (contentLength < 1) {
    throw Errors.uploadInvalid('contentLength must be at least 1 byte.');
  }
  if (contentLength > MAX_UPLOAD_BYTES) {
    throw Errors.uploadInvalid(
      `Upload exceeds the ${MAX_UPLOAD_BYTES} byte (10MB) limit.`,
    );
  }
  return contentLength;
}

export async function createPresignedPutUrl(params: {
  objectKey: string;
  contentType: string;
  contentLength?: number;
  expiresIn?: number;
}): Promise<{ uploadUrl: string; expiresIn: number }> {
  const contentType = normalizeContentType(params.contentType);
  extensionForContentType(contentType);

  const contentLength =
    params.contentLength === undefined
      ? undefined
      : assertUploadContentLength(params.contentLength);

  const expiresIn = params.expiresIn ?? PRESIGNED_URL_EXPIRES_IN;

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: params.objectKey,
      ContentType: contentType,
      ...(contentLength !== undefined ? { ContentLength: contentLength } : {}),
    }),
    { expiresIn },
  );

  return { uploadUrl, expiresIn };
}
