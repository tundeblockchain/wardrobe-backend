import { AppError } from '../../src/shared/errors';
import { PROCESS_WARDROBE_ITEM_JOB, RENDER_OUTFIT_JOB } from '../../src/shared/types';

const mockSqsSend = jest.fn();

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({ send: mockSqsSend })),
  SendMessageCommand: jest.fn().mockImplementation((input: unknown) => ({
    _op: 'SendMessage',
    input,
  })),
}));

import { SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  enqueueProcessWardrobeItem,
  enqueueRenderOutfit,
  parseProcessWardrobeItemJob,
  parseRenderOutfitJob,
  processingQueueUrl,
  tryOnQueueUrl,
} from '../../src/shared/sqs';

const QUEUE_URL =
  'https://sqs.eu-west-1.amazonaws.com/123456789012/wardrobe-item-processing-test';
const TRY_ON_QUEUE_URL =
  'https://sqs.eu-west-1.amazonaws.com/123456789012/wardrobe-outfit-render-test';

describe('sqs helpers (WARDROBE-16)', () => {
  const originalQueueUrl = process.env.PROCESSING_QUEUE_URL;
  const originalTryOnQueueUrl = process.env.TRY_ON_QUEUE_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PROCESSING_QUEUE_URL = QUEUE_URL;
    process.env.TRY_ON_QUEUE_URL = TRY_ON_QUEUE_URL;
    mockSqsSend.mockResolvedValue({ MessageId: 'msg-1' });
  });

  afterEach(() => {
    if (originalQueueUrl === undefined) {
      delete process.env.PROCESSING_QUEUE_URL;
    } else {
      process.env.PROCESSING_QUEUE_URL = originalQueueUrl;
    }
    if (originalTryOnQueueUrl === undefined) {
      delete process.env.TRY_ON_QUEUE_URL;
    } else {
      process.env.TRY_ON_QUEUE_URL = originalTryOnQueueUrl;
    }
  });

  describe('processingQueueUrl', () => {
    it('returns PROCESSING_QUEUE_URL', () => {
      expect(processingQueueUrl()).toBe(QUEUE_URL);
    });

    it('throws INTERNAL_ERROR when the queue URL is not configured', () => {
      delete process.env.PROCESSING_QUEUE_URL;
      expect(() => processingQueueUrl()).toThrow(AppError);
      try {
        processingQueueUrl();
      } catch (error) {
        const appError = error as AppError;
        expect(appError.code).toBe('INTERNAL_ERROR');
        expect(appError.statusCode).toBe(500);
      }
    });
  });

  describe('parseProcessWardrobeItemJob', () => {
    const valid = {
      jobType: PROCESS_WARDROBE_ITEM_JOB,
      userId: 'firebase-uid-123',
      wardrobeId: 'wd_abc123xyz0',
      itemId: 'item_xyz123abcd',
      originalImageKey: 'users/firebase-uid-123/uploads/photo.jpg',
    };

    it('parses the architecture payload', () => {
      expect(parseProcessWardrobeItemJob(JSON.stringify(valid))).toEqual(valid);
    });

    it('returns undefined for invalid JSON, wrong job type, or missing fields', () => {
      expect(parseProcessWardrobeItemJob('not-json')).toBeUndefined();
      expect(parseProcessWardrobeItemJob(JSON.stringify([]))).toBeUndefined();
      expect(
        parseProcessWardrobeItemJob(JSON.stringify({ ...valid, jobType: 'OTHER' })),
      ).toBeUndefined();
      expect(
        parseProcessWardrobeItemJob(JSON.stringify({ ...valid, itemId: '   ' })),
      ).toBeUndefined();
      expect(
        parseProcessWardrobeItemJob(
          JSON.stringify({
            jobType: PROCESS_WARDROBE_ITEM_JOB,
            userId: valid.userId,
          }),
        ),
      ).toBeUndefined();
    });
  });

  describe('enqueueProcessWardrobeItem', () => {
    it('sends PROCESS_WARDROBE_ITEM with the architecture payload', async () => {
      await enqueueProcessWardrobeItem({
        userId: 'firebase-uid-123',
        wardrobeId: 'wd_abc123xyz0',
        itemId: 'item_xyz123abcd',
        originalImageKey: 'users/firebase-uid-123/uploads/photo.jpg',
      });

      expect(SendMessageCommand).toHaveBeenCalledWith({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify({
          jobType: PROCESS_WARDROBE_ITEM_JOB,
          userId: 'firebase-uid-123',
          wardrobeId: 'wd_abc123xyz0',
          itemId: 'item_xyz123abcd',
          originalImageKey: 'users/firebase-uid-123/uploads/photo.jpg',
        }),
      });
      expect(mockSqsSend).toHaveBeenCalledTimes(1);
    });

    it('wraps SQS failures as INTERNAL_ERROR', async () => {
      mockSqsSend.mockRejectedValue(new Error('sqs unavailable'));

      await expect(
        enqueueProcessWardrobeItem({
          userId: 'firebase-uid-123',
          wardrobeId: 'wd_abc123xyz0',
          itemId: 'item_xyz123abcd',
          originalImageKey: 'users/firebase-uid-123/uploads/photo.jpg',
        }),
      ).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
        statusCode: 500,
        message: 'Failed to enqueue clothing-item processing job.',
      });
    });
  });

  describe('tryOnQueueUrl', () => {
    it('returns TRY_ON_QUEUE_URL', () => {
      expect(tryOnQueueUrl()).toBe(TRY_ON_QUEUE_URL);
    });

    it('throws INTERNAL_ERROR when the queue URL is not configured', () => {
      delete process.env.TRY_ON_QUEUE_URL;
      expect(() => tryOnQueueUrl()).toThrow(AppError);
    });
  });

  describe('parseRenderOutfitJob', () => {
    const valid = {
      jobType: RENDER_OUTFIT_JOB,
      userId: 'firebase-uid-123',
      wardrobeId: 'wd_abc123xyz0',
      outfitId: 'outfit_xyz123ab',
      aiProfileId: 'profile_generic_01',
    };

    it('parses the RENDER_OUTFIT payload', () => {
      expect(parseRenderOutfitJob(JSON.stringify(valid))).toEqual(valid);
    });

    it('returns undefined for invalid JSON, wrong job type, or missing fields', () => {
      expect(parseRenderOutfitJob('not-json')).toBeUndefined();
      expect(
        parseRenderOutfitJob(JSON.stringify({ ...valid, jobType: 'PROCESS_WARDROBE_ITEM' })),
      ).toBeUndefined();
      expect(
        parseRenderOutfitJob(JSON.stringify({ ...valid, aiProfileId: '   ' })),
      ).toBeUndefined();
    });
  });

  describe('enqueueRenderOutfit', () => {
    it('sends RENDER_OUTFIT with the architecture payload', async () => {
      await enqueueRenderOutfit({
        userId: 'firebase-uid-123',
        wardrobeId: 'wd_abc123xyz0',
        outfitId: 'outfit_xyz123ab',
        aiProfileId: 'profile_generic_01',
      });

      expect(SendMessageCommand).toHaveBeenCalledWith({
        QueueUrl: TRY_ON_QUEUE_URL,
        MessageBody: JSON.stringify({
          jobType: RENDER_OUTFIT_JOB,
          userId: 'firebase-uid-123',
          wardrobeId: 'wd_abc123xyz0',
          outfitId: 'outfit_xyz123ab',
          aiProfileId: 'profile_generic_01',
        }),
      });
    });

    it('wraps SQS failures as INTERNAL_ERROR', async () => {
      mockSqsSend.mockRejectedValue(new Error('sqs unavailable'));

      await expect(
        enqueueRenderOutfit({
          userId: 'firebase-uid-123',
          wardrobeId: 'wd_abc123xyz0',
          outfitId: 'outfit_xyz123ab',
          aiProfileId: 'profile_generic_01',
        }),
      ).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'Failed to enqueue outfit render job.',
      });
    });
  });
});
