import {
  newWardrobeId,
  newItemId,
  newOutfitId,
  newAiProfileId,
  newUploadId,
  nowIso,
} from '../../src/shared/ids';

describe('ids', () => {
  describe('newWardrobeId', () => {
    it('should return a string prefixed with "wd_"', () => {
      const id = newWardrobeId();
      expect(id).toMatch(/^wd_[A-Za-z0-9_-]{12}$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => newWardrobeId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('newItemId', () => {
    it('should return a string prefixed with "item_"', () => {
      const id = newItemId();
      expect(id).toMatch(/^item_[A-Za-z0-9_-]{12}$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => newItemId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('newOutfitId', () => {
    it('should return a string prefixed with "outfit_"', () => {
      const id = newOutfitId();
      expect(id).toMatch(/^outfit_[A-Za-z0-9_-]{12}$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => newOutfitId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('newAiProfileId', () => {
    it('should return a string prefixed with "profile_"', () => {
      const id = newAiProfileId();
      expect(id).toMatch(/^profile_[A-Za-z0-9_-]{12}$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => newAiProfileId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('newUploadId', () => {
    it('should return a 16-character string', () => {
      const id = newUploadId();
      expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => newUploadId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('nowIso', () => {
    it('should return a valid ISO 8601 timestamp', () => {
      const timestamp = nowIso();
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('should return the current time', () => {
      const before = new Date().toISOString();
      const timestamp = nowIso();
      const after = new Date().toISOString();

      expect(timestamp >= before).toBe(true);
      expect(timestamp <= after).toBe(true);
    });
  });
});
