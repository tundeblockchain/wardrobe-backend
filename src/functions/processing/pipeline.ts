import { DynamoItem } from '../../shared/types';
import { runBackgroundRemoval } from './background-removal';

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

/**
 * Ordered clothing-item processing pipeline.
 *
 *   1. removeBackground        — WARDROBE-18 (S3 + injectable rembg client)
 *   2. classifyGarment         — WARDROBE-19 (no-op stub)
 *   3. detectColourAndCategory — WARDROBE-20 (no-op stub)
 */
export async function runProcessingPipeline(
  context: ProcessingContext,
): Promise<void> {
  await removeBackground(context);
  await classifyGarment(context);
  await detectColourAndCategory(context);
}

/** WARDROBE-18: read original from S3, remove background, write processed.png. */
export async function removeBackground(
  context: ProcessingContext,
): Promise<void> {
  await runBackgroundRemoval(context);
}

/** WARDROBE-19: AI garment classification. No-op stub — no model calls. */
export async function classifyGarment(
  _context: ProcessingContext,
): Promise<void> {
  // Intentionally empty. WARDROBE-19 persists detected category/subcategory.
}

/** WARDROBE-20: colour / category detection. No-op stub — no model calls. */
export async function detectColourAndCategory(
  _context: ProcessingContext,
): Promise<void> {
  // Intentionally empty. WARDROBE-20 persists detected colours / category.
}
