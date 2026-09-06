/**
 * Phase-3 hooks.
 *
 * WARDROBE-44 — reference-image upload + PROCESS_AI_PROFILE job shape
 * WARDROBE-45 — seed GENERIC_MODEL rows via `buildGenericModelProfile` + catalog
 * WARDROBE-47 — try-on secret id + RENDER_OUTFIT job (dedicated queue)
 */

import {
  AiProfileStatus,
  PROCESS_AI_PROFILE_JOB,
  ProcessAiProfileJob,
  RENDER_OUTFIT_JOB,
  RenderOutfitJob,
} from '../../shared/types';

/** Secrets Manager id created by WARDROBE-47 (`wardrobe/{stage}/gemini-try-on`). */
export function tryOnSecretName(stage: string): string {
  return `wardrobe/${stage}/gemini-try-on`;
}

export const FUTURE_JOB_TYPES = {
  processAiProfile: PROCESS_AI_PROFILE_JOB,
  renderOutfit: RENDER_OUTFIT_JOB,
} as const;

/**
 * Status after confirmed reference images are attached (WARDROBE-44).
 *
 * No PROCESS_AI_PROFILE worker exists yet, so attach writes the keys and
 * moves the profile to READY. A later worker ticket can:
 *
 * 1. Change this helper to return `PENDING`
 * 2. Enqueue `buildProcessAiProfileJob(...)`
 * 3. Worker: PENDING → PROCESSING → READY | FAILED
 *
 * Do not enqueue onto the clothing-item queue — that worker only accepts
 * PROCESS_WARDROBE_ITEM and would treat this job as poison. Outfit try-on
 * uses a dedicated RENDER_OUTFIT queue (WARDROBE-47).
 */
export function statusAfterReferenceImagesAttached(): AiProfileStatus {
  return 'READY';
}

/** Job body for the WARDROBE-47 try-on worker. */
export function buildRenderOutfitJob(
  userId: string,
  wardrobeId: string,
  outfitId: string,
  aiProfileId: string,
): RenderOutfitJob {
  return {
    jobType: RENDER_OUTFIT_JOB,
    userId,
    wardrobeId,
    outfitId,
    aiProfileId,
  };
}

/** Job body for a future PROCESS_AI_PROFILE worker. Not enqueued here. */
export function buildProcessAiProfileJob(
  userId: string,
  aiProfileId: string,
): ProcessAiProfileJob {
  return {
    jobType: PROCESS_AI_PROFILE_JOB,
    userId,
    aiProfileId,
  };
}
