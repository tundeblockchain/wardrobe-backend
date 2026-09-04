import { MAX_UPLOAD_BYTES } from '../../src/shared/s3';

const mockGetSignedUrl = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({})),
  PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'PutObject',
    input,
  })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

import { AppError } from '../../src/shared/errors';
import {
  assertUploadContentLength,
  bucketName,
  createPresignedPutUrl,
  extensionForContentType,
  PRESIGNED_URL_EXPIRES_IN,
} from '../../src/shared/s3';

describe('s3 helpers (WARDROBE-8)', () => {
  const originalBucket = process.env.MEDIA_BUCKET_NAME;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MEDIA_BUCKET_NAME = 'wardrobe-media-test';
    mockGetSignedUrl.mockResolvedValue('https://signed.example/put');
  });

  afterEach(() => {
    if (originalBucket === undefined) {
      delete process.env.MEDIA_BUCKET_NAME;
    } else {
      process.env.MEDIA_BUCKET_NAME = originalBucket;
    }
  });

  describe('bucketName', () => {
    it('returns MEDIA_BUCKET_NAME', () => {
      expect(bucketName()).toBe('wardrobe-media-test');
    });

    it('throws INTERNAL_ERROR when the bucket is not configured', () => {
      delete process.env.MEDIA_BUCKET_NAME;
      expect(() => bucketName()).toThrow(AppError);
      try {
        bucketName();
      } catch (error) {
        const appError = error as AppError;
        expect(appError.code).toBe('INTERNAL_ERROR');
        expect(appError.statusCode).toBe(500);
      }
    });
  });

  describe('extensionForContentType', () => {
    it('maps the image allowlist', () => {
      expect(extensionForContentType('image/jpeg')).toBe('jpg');
      expect(extensionForContentType('image/png')).toBe('png');
      expect(extensionForContentType('image/webp')).toBe('webp');
      expect(extensionForContentType('image/heic')).toBe('heic');
    });

    it('throws UPLOAD_INVALID for types outside the allowlist', () => {
      expect(() => extensionForContentType('image/gif')).toThrow(AppError);
      try {
        extensionForContentType('image/gif');
      } catch (error) {
        const appError = error as AppError;
        expect(appError.code).toBe('UPLOAD_INVALID');
        expect(appError.statusCode).toBe(400);
      }
    });
  });

  describe('assertUploadContentLength', () => {
    it('accepts the 10MB boundary', () => {
      expect(assertUploadContentLength(1)).toBe(1);
      expect(assertUploadContentLength(MAX_UPLOAD_BYTES)).toBe(MAX_UPLOAD_BYTES);
    });

    it('rejects oversized and empty uploads', () => {
      expect(() => assertUploadContentLength(0)).toThrow(AppError);
      expect(() => assertUploadContentLength(MAX_UPLOAD_BYTES + 1)).toThrow(
        AppError,
      );
      try {
        assertUploadContentLength(MAX_UPLOAD_BYTES + 1);
      } catch (error) {
        const appError = error as AppError;
        expect(appError.code).toBe('UPLOAD_INVALID');
      }
    });
  });

  describe('createPresignedPutUrl', () => {
    it('signs a private PutObject with ContentType only', async () => {
      const result = await createPresignedPutUrl({
        objectKey: 'users/uid/uploads/abc.jpg',
        contentType: 'image/jpeg',
      });

      expect(result).toEqual({
        uploadUrl: 'https://signed.example/put',
        expiresIn: PRESIGNED_URL_EXPIRES_IN,
      });

      const command = mockGetSignedUrl.mock.calls[0][1] as {
        input: Record<string, unknown>;
      };
      expect(command.input).toEqual({
        Bucket: 'wardrobe-media-test',
        Key: 'users/uid/uploads/abc.jpg',
        ContentType: 'image/jpeg',
      });
    });

    it('includes ContentLength in the signed PutObject when provided', async () => {
      await createPresignedPutUrl({
        objectKey: 'users/uid/uploads/abc.jpg',
        contentType: 'image/jpeg',
        contentLength: 4096,
      });

      const command = mockGetSignedUrl.mock.calls[0][1] as {
        input: { ContentLength?: number };
      };
      expect(command.input.ContentLength).toBe(4096);
    });

    it('does not call S3 when contentType is not allowed', async () => {
      await expect(
        createPresignedPutUrl({
          objectKey: 'users/uid/uploads/abc.bin',
          contentType: 'application/octet-stream',
        }),
      ).rejects.toMatchObject({ code: 'UPLOAD_INVALID' });
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });
  });
});
