import { DynamoItem } from '../../shared/types';
import {
  isBackgroundRemovalEnabled,
  runBackgroundRemoval,
} from './background-removal';
import {
  classifyGarment as runClassifyGarment,
  type ClassifyGarmentDeps,
} from './classify';
import {
  detectColourAndCategory as runDetectColourAndCategory,
  type DetectColourAndCategoryDeps,
} from './colour-detect';
import {
  logGeminiPipelineStage,
  type GeminiPipelineStage,
} from './gemini';

/**
 * Dynamo-validated work context. Callers must load the clothing item
 * from DynamoDB and treat these fields as source of truth — never the
 * raw SQS body alone.
 */
export interface ProcessingContext {
  userId: string;
  wardrobeId: string;
  itemId: string;
  originalImageKey: string;
  item: DynamoItem;
}

export type ProcessingPipelineDeps = ClassifyGarmentDeps &
  DetectColourAndCategoryDeps;

/**
 * Ordered clothing-item processing pipeline.
 *
 *   1. removeBackground        — WARDROBE-18/26 (S3 + injectable Gemini client).
 *                                Gated by BACKGROUND_REMOVAL_ENABLED (WARDROBE-62;
 *                                default off). When skipped, classify / colour
 *                                use the original image.
 *   2. classifyGarment         — WARDROBE-19/27 (injectable Gemini classifier; `ai` only)
 *   3. detectColourAndCategory — WARDROBE-20/29 (injectable Gemini detector; `ai` only)
 *
 * The worker sets processingStatus READY after this function returns.
 */
export async function runProcessingPipeline(
  context: ProcessingContext,
  deps?: ProcessingPipelineDeps,
): Promise<void> {
  await runStage('bg-removal', context, () => removeBackground(context));
  await runStage('classify', context, () => classifyGarment(context, deps));
  await runStage('colour', context, () =>
    detectColourAndCategory(context, deps),
  );
}

async function runStage(
  stage: GeminiPipelineStage,
  context: ProcessingContext,
  work: () => Promise<void>,
): Promise<void> {
  logGeminiPipelineStage('start', {
    stage,
    itemId: context.itemId,
    wardrobeId: context.wardrobeId,
  });
  try {
    await work();
    logGeminiPipelineStage('success', {
      stage,
      itemId: context.itemId,
      wardrobeId: context.wardrobeId,
    });
  } catch (error) {
    logGeminiPipelineStage('fail', {
      stage,
      itemId: context.itemId,
      wardrobeId: context.wardrobeId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    throw error;
  }
}

/**
 * WARDROBE-18/26: read original from S3, Gemini bg-remove, write processed.png.
 * WARDROBE-62: skip entirely when BACKGROUND_REMOVAL_ENABLED is not true so
 * Gemini "did not return an image" cannot fail add-item.
 */
export async function removeBackground(
  context: ProcessingContext,
): Promise<void> {
  if (!isBackgroundRemovalEnabled()) {
    logGeminiPipelineStage('skip', {
      stage: 'bg-removal',
      itemId: context.itemId,
      wardrobeId: context.wardrobeId,
      reason: 'BACKGROUND_REMOVAL_ENABLED is off',
    });
    return;
  }

  const processedKey = await runBackgroundRemoval(context);
  if (!processedKey) {
    return;
  }
  rememberProcessedImage(context, processedKey);
}

/** WARDROBE-19/27: Gemini garment classification. Persists under `ai` only. */
export async function classifyGarment(
  context: ProcessingContext,
  deps?: ClassifyGarmentDeps,
): Promise<void> {
  await runClassifyGarment(context, deps);
}

/** WARDROBE-20/29: Gemini colour / category detection. Persists under `ai` only. */
export async function detectColourAndCategory(
  context: ProcessingContext,
  deps?: DetectColourAndCategoryDeps,
): Promise<void> {
  await runDetectColourAndCategory(context, deps);
}

function rememberProcessedImage(
  context: ProcessingContext,
  processedKey: string,
): void {
  context.item.processedKey = processedKey;
  const existing = context.item.ai;
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  context.item.ai = {
    ...base,
    backgroundRemoved: true,
    processedImageKey: processedKey,
  };
}
