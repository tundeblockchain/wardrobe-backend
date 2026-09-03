import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Errors } from './errors';

const s3 = new S3Client({});

const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

const DEFAULT_EXPIRES_IN = 900;

export function bucketName(): string {
  const name = process.env.MEDIA_BUCKET_NAME;
  if (!name) {
    throw Errors.internal('MEDIA_BUCKET_NAME is not configured.');
  }
  return name;
}

export function extensionForContentType(contentType: string): string {
  const extension = ALLOWED_CONTENT_TYPES[contentType];
  if (!extension) {
    throw Errors.uploadInvalid(
      'Unsupported content type. Use image/jpeg, image/png, image/webp, or image/heic.',
    );
  }
  return extension;
}

export async function createPresignedPutUrl(params: {
  objectKey: string;
  contentType: string;
  expiresIn?: number;
}): Promise<{ uploadUrl: string; expiresIn: number }> {
  const expiresIn = params.expiresIn ?? DEFAULT_EXPIRES_IN;

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: params.objectKey,
      ContentType: params.contentType,
    }),
    { expiresIn },
  );

  return { uploadUrl, expiresIn };
}
