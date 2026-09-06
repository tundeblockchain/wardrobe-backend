import { nanoid } from 'nanoid';

export function newWardrobeId(): string {
  return `wd_${nanoid(12)}`;
}

export function newItemId(): string {
  return `item_${nanoid(12)}`;
}

export function newOutfitId(): string {
  return `outfit_${nanoid(12)}`;
}

export function newAiProfileId(): string {
  return `profile_${nanoid(12)}`;
}

export function newUploadId(): string {
  return nanoid(16);
}

export function nowIso(): string {
  return new Date().toISOString();
}
