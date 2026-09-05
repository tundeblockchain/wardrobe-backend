import { DynamoItem } from '../../shared/types';
import { runBackgroundRemoval } from './background-removal';
import {
  classifyGarment as runClassifyGarment,
  type ClassifyGarmentDeps,
} from './classify';
import {
  detectColourAndCategory as runDetectColourAndCategory,
  type DetectColourAndCategoryDeps,
} from './colour-detect';

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
 *   1. removeBackground        — WARDROBE-18 (S3 + injectable rembg client)
 *   2. classifyGarment         — WARDROBE-19 (injectable classifier; `ai` only)
 *   3. detectColourAndCategory — WARDROBE-20 (injectable detector; `ai` only)
 *
 * The worker sets processingStatus READY after this function returns.
 */
export async function runProcessingPipeline(
  context: ProcessingContext,
  deps?: ProcessingPipelineDeps,
): Promise<void> {
  await removeBackground(context);
  await classifyGarment(context, deps);
  await detectColourAndCategory(context, deps);
}

/** WARDROBE-18: read original from S3, remove background, write processed.png. */
export async function removeBackground(
  context: ProcessingContext,
): Promise<void> {
  const processedKey = await runBackgroundRemoval(context);
  rememberProcessedImage(context, processedKey);
}

/** WARDROBE-19: AI garment classification. Persists under `ai` only. */
export async function classifyGarment(
  context: ProcessingContext,
  deps?: ClassifyGarmentDeps,
): Promise<void> {
  await runClassifyGarment(context, deps);
}

/** WARDROBE-20: colour / category detection. Persists under `ai` only. */
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
