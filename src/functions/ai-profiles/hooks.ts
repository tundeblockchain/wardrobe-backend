/**
 * Phase-3 hooks for later tickets. WARDROBE-43 does not call inference.
 *
 * WARDROBE-44 — reference-image upload + optional PROCESS_AI_PROFILE job
 * WARDROBE-45 — seed GENERIC_MODEL rows via `buildGenericModelProfile`
 * WARDROBE-47 — try-on / outfit render worker using this secret id
 */

import { PROCESS_AI_PROFILE_JOB, RENDER_OUTFIT_JOB } from '../../shared/types';

/** Reserved Secrets Manager id. Not created in this ticket — WARDROBE-47. */
export function tryOnSecretName(stage: string): string {
  return `wardrobe/${stage}/gemini-try-on`;
}

export const FUTURE_JOB_TYPES = {
  processAiProfile: PROCESS_AI_PROFILE_JOB,
  renderOutfit: RENDER_OUTFIT_JOB,
} as const;
