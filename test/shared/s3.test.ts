const mockGetSignedUrl = jest.fn();
const mockSend = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockSend })),
  PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'PutObject',
    input,
  })),
  GetObjectCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'GetObject',
    input,
  })),
  ListObjectsV2Command: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'ListObjectsV2',
    input,
  })),
  DeleteObjectsCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'DeleteObjects',
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
  deleteObjectsUnderUserPrefix,
  extensionForContentType,
  getObjectBytes,
  MAX_UPLOAD_BYTES,
  PRESIGNED_URL_EXPIRES_IN,
  processedImageObjectKey,
  putObjectBytes,
  userMediaPrefix,
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

  describe('processedImageObjectKey', () => {
    it('uses users/{userId}/items/{itemId}/processed.png', () => {
      expect(processedImageObjectKey('uid-1', 'item_abc')).toBe(
        'users/uid-1/items/item_abc/processed.png',
      );
    });
  });

  describe('userMediaPrefix', () => {
    it('returns users/{uid}/', () => {
      expect(userMediaPrefix('firebase-uid-1')).toBe('users/firebase-uid-1/');
    });

    it('rejects path-like user ids so a wipe cannot escape the prefix', () => {
      expect(() => userMediaPrefix('../other')).toThrow(AppError);
      expect(() => userMediaPrefix('uid/../other')).toThrow(AppError);
      expect(() => userMediaPrefix('uid/extra')).toThrow(AppError);
    });
  });

  describe('deleteObjectsUnderUserPrefix', () => {
    it('lists and deletes only keys under users/{uid}/', async () => {
      mockSend
        .mockResolvedValueOnce({
          Contents: [
            { Key: 'users/uid-1/uploads/a.jpg' },
            { Key: 'users/uid-1/items/item_1/processed.png' },
            { Key: 'users/other/uploads/leak.jpg' },
          ],
          IsTruncated: false,
        })
        .mockResolvedValueOnce({
          Deleted: [
            { Key: 'users/uid-1/uploads/a.jpg' },
            { Key: 'users/uid-1/items/item_1/processed.png' },
          ],
        });

      await expect(deleteObjectsUnderUserPrefix('uid-1')).resolves.toEqual({
        deleted: 2,
        failed: 0,
      });

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          _op: 'ListObjectsV2',
          input: expect.objectContaining({
            Bucket: 'wardrobe-media-test',
            Prefix: 'users/uid-1/',
          }),
        }),
      );
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          _op: 'DeleteObjects',
          input: {
            Bucket: 'wardrobe-media-test',
            Delete: {
              Objects: [
                { Key: 'users/uid-1/uploads/a.jpg' },
                { Key: 'users/uid-1/items/item_1/processed.png' },
              ],
              Quiet: false,
            },
          },
        }),
      );
    });

    it('counts individual object errors and continues', async () => {
      mockSend
        .mockResolvedValueOnce({
          Contents: [{ Key: 'users/uid-1/uploads/a.jpg' }],
          IsTruncated: false,
        })
        .mockResolvedValueOnce({
          Deleted: [],
          Errors: [{ Key: 'users/uid-1/uploads/a.jpg', Code: 'AccessDenied' }],
        });

      await expect(deleteObjectsUnderUserPrefix('uid-1')).resolves.toEqual({
        deleted: 0,
        failed: 1,
      });
    });

    it('does not throw when listing fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('S3 unavailable'));

      await expect(deleteObjectsUnderUserPrefix('uid-1')).resolves.toEqual({
        deleted: 0,
        failed: 1,
      });
    });

    it('returns zeros when the prefix is already empty', async () => {
      mockSend.mockResolvedValueOnce({ Contents: [], IsTruncated: false });

      await expect(deleteObjectsUnderUserPrefix('uid-1')).resolves.toEqual({
        deleted: 0,
        failed: 0,
      });
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('getObjectBytes / putObjectBytes', () => {
    it('reads object bytes from the private media bucket', async () => {
      const bytes = Uint8Array.from([1, 2, 3]);
      mockSend.mockResolvedValue({
        Body: { transformToByteArray: async () => bytes },
        ContentType: 'image/jpeg',
      });

      await expect(getObjectBytes('users/uid/uploads/a.jpg')).resolves.toEqual({
        bytes,
        contentType: 'image/jpeg',
      });
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          _op: 'GetObject',
          input: {
            Bucket: 'wardrobe-media-test',
            Key: 'users/uid/uploads/a.jpg',
          },
        }),
      );
    });

    it('writes processed bytes without deleting the original', async () => {
      mockSend.mockResolvedValue({});
      const body = Uint8Array.from([0x89, 0x50]);

      await putObjectBytes({
        objectKey: 'users/uid/items/item_1/processed.png',
        body,
        contentType: 'image/png',
      });

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          _op: 'PutObject',
          input: {
            Bucket: 'wardrobe-media-test',
            Key: 'users/uid/items/item_1/processed.png',
            Body: body,
            ContentType: 'image/png',
          },
        }),
      );
    });
  });
});
