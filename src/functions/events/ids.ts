import { createHash } from 'crypto';
import { JobEventStatus, PROCESS_WARDROBE_ITEM_JOB } from '../../shared/types';

/**
 * Deterministic inbox ids so worker retries and DLQ replays do not
 * duplicate Flutter events (WARDROBE-114).
 */
export function itemJobEventId(itemId: string, status: JobEventStatus): string {
  return `evt_item_${itemId}_${status}`;
}

export function renderJobEventId(
  renderKey: string,
  status: JobEventStatus,
): string {
  return `evt_render_${renderKey}_${status}`;
}

export function jobEventId(input: {
  jobType: string;
  status: JobEventStatus;
  itemId?: string;
  outfitId?: string;
  renderId?: string;
  aiProfileId?: string;
}): string {
  if (input.jobType === PROCESS_WARDROBE_ITEM_JOB) {
    return itemJobEventId(String(input.itemId ?? '').trim(), input.status);
  }
  const renderId = String(input.renderId ?? '').trim();
  if (renderId) {
    return renderJobEventId(renderId, input.status);
  }
  const outfitId = String(input.outfitId ?? '').trim() || 'unknown';
  const profileId = String(input.aiProfileId ?? '').trim() || 'unknown';
  return renderJobEventId(`${outfitId}_${profileId}`, input.status);
}

/** Stable device id when Flutter omits `deviceId` — same token maps to one row. */
export function deviceIdFromToken(token: string): string {
  return `dev_${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
}
