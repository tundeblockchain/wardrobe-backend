import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Errors } from './errors';
import { logger } from './logger';

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

export function processedImageObjectKey(userId: string, itemId: string): string {
  return `users/${userId}/items/${itemId}/processed.png`;
}

/** Architecture §24: users/{uid}/outfits/{outfitId}/render.png */
export function outfitRenderObjectKey(userId: string, outfitId: string): string {
  const uid = userId.trim();
  const id = outfitId.trim();
  if (!isSafeObjectKeySegment(uid) || !isSafeObjectKeySegment(id)) {
    throw Errors.internal(
      'Refusing to build an outfit render key for an invalid id.',
    );
  }
  return `users/${uid}/outfits/${id}/render.png`;
}

export async function createPresignedGetUrl(params: {
  objectKey: string;
  expiresIn?: number;
}): Promise<{ imageUrl: string; expiresIn: number }> {
  const expiresIn = params.expiresIn ?? PRESIGNED_URL_EXPIRES_IN;
  const imageUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucketName(),
      Key: params.objectKey,
    }),
    { expiresIn },
  );
  return { imageUrl, expiresIn };
}

function isSafeObjectKeySegment(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('..') &&
    !value.includes('\0')
  );
}

/**
 * Owner-scoped prefix for PERSONAL AI profile reference photos (WARDROBE-44).
 * Keys must stay under `users/{uid}/ai-profiles/{aiProfileId}/`.
 */
export function aiProfileReferencePrefix(
  userId: string,
  aiProfileId: string,
): string {
  const uid = userId.trim();
  const profileId = aiProfileId.trim();
  if (!isSafeObjectKeySegment(uid) || !isSafeObjectKeySegment(profileId)) {
    throw Errors.validation(
      'aiProfileId is not a valid object-key segment.',
    );
  }
  return `users/${uid}/ai-profiles/${profileId}/`;
}

export async function getObjectBytes(objectKey: string): Promise<{
  bytes: Uint8Array;
  contentType?: string;
}> {
  const result = await s3.send(
    new GetObjectCommand({
      Bucket: bucketName(),
      Key: objectKey,
    }),
  );

  if (!result.Body) {
    throw new Error(`S3 object ${objectKey} has no body.`);
  }

  return {
    bytes: await result.Body.transformToByteArray(),
    contentType: result.ContentType,
  };
}

export async function putObjectBytes(params: {
  objectKey: string;
  body: Uint8Array;
  contentType: string;
}): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: params.objectKey,
      Body: params.body,
      ContentType: params.contentType,
    }),
  );
}

/** Uploads and processed images live under users/{uid}/… */
export function userMediaPrefix(userId: string): string {
  const trimmed = userId.trim();
  if (
    !trimmed ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('..') ||
    trimmed.includes('\0')
  ) {
    throw Errors.internal('Refusing to build an S3 prefix for an invalid user id.');
  }
  return `users/${trimmed}/`;
}

export interface DeleteUserPrefixResult {
  deleted: number;
  failed: number;
}

/**
 * Best-effort delete of every object under users/{uid}/.
 * Logs and continues on individual object or list failures.
 */
export async function deleteObjectsUnderUserPrefix(
  userId: string,
): Promise<DeleteUserPrefixResult> {
  const prefix = userMediaPrefix(userId);
  let deleted = 0;
  let failed = 0;
  let continuationToken: string | undefined;

  do {
    let keys: string[];
    try {
      const listed = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucketName(),
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      keys = (listed.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string =>
          Boolean(key && key.startsWith(prefix) && key.length > prefix.length),
        );
      continuationToken = listed.IsTruncated
        ? listed.NextContinuationToken
        : undefined;
    } catch (error) {
      logger.warn('S3 list failed during user media wipe', {
        prefix,
        error: error instanceof Error ? error.message : 'unknown',
      });
      return { deleted, failed: failed + 1 };
    }

    const chunkSize = 1000;
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize);
      try {
        const result = await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucketName(),
            Delete: {
              Objects: chunk.map((Key) => ({ Key })),
              Quiet: false,
            },
          }),
        );
        deleted += result.Deleted?.length ?? 0;
        for (const objectError of result.Errors ?? []) {
          failed += 1;
          logger.warn('S3 object delete failed', {
            key: objectError.Key,
            code: objectError.Code,
            message: objectError.Message,
          });
        }
      } catch (error) {
        failed += chunk.length;
        logger.warn('S3 delete batch failed during user media wipe', {
          prefix,
          count: chunk.length,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
  } while (continuationToken);

  return { deleted, failed };
}
