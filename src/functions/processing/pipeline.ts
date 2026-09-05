import { DynamoItem } from '../../shared/types';

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
 * Later tickets replace these no-op hooks in place. Do not add RemBG,
 * vision APIs, Secrets Manager AI keys, or other external model calls
 * in this ticket (WARDROBE-17).
 *
 *   1. removeBackground        — WARDROBE-18
 *   2. classifyGarment         — WARDROBE-19
 *   3. detectColourAndCategory — WARDROBE-20
 */
export async function runProcessingPipeline(
  context: ProcessingContext,
): Promise<void> {
  await removeBackground(context);
  await classifyGarment(context);
  await detectColourAndCategory(context);
}

/** WARDROBE-18: background removal. No-op stub — no RemBG / image I/O. */
export async function removeBackground(
  _context: ProcessingContext,
): Promise<void> {
  // Intentionally empty. WARDROBE-18 writes the processed image to S3.
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
