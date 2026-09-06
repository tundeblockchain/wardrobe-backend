export const CLOTHING_CATEGORIES = [
  'TOP',
  'BOTTOM',
  'DRESS',
  'OUTERWEAR',
  'SHOES',
  'ACCESSORY',
  'BAG',
] as const;

export type ClothingCategory = (typeof CLOTHING_CATEGORIES)[number];

/** Controlled garment subcategories used by AI classification (WARDROBE-19). */
export const CLOTHING_SUBCATEGORIES = [
  'TSHIRT',
  'SHIRT',
  'BLOUSE',
  'POLO',
  'SWEATER',
  'HOODIE',
  'JEANS',
  'TROUSERS',
  'SHORTS',
  'SKIRT',
  'DRESS',
  'JUMPSUIT',
  'ROMPER',
  'JACKET',
  'COAT',
  'BLAZER',
  'SNEAKERS',
  'BOOTS',
  'HEELS',
  'SANDALS',
  'FLATS',
  'HAT',
  'BELT',
  'SCARF',
  'JEWELRY',
  'SUNGLASSES',
  'WATCH',
  'HANDBAG',
  'BACKPACK',
  'TOTE',
  'CLUTCH',
  'CROSSBODY',
] as const;

export type ClothingSubcategory = (typeof CLOTHING_SUBCATEGORIES)[number];

export const SUBCATEGORIES_BY_CATEGORY: Record<
  ClothingCategory,
  readonly ClothingSubcategory[]
> = {
  TOP: ['TSHIRT', 'SHIRT', 'BLOUSE', 'POLO', 'SWEATER', 'HOODIE'],
  BOTTOM: ['JEANS', 'TROUSERS', 'SHORTS', 'SKIRT'],
  DRESS: ['DRESS', 'JUMPSUIT', 'ROMPER'],
  OUTERWEAR: ['JACKET', 'COAT', 'BLAZER'],
  SHOES: ['SNEAKERS', 'BOOTS', 'HEELS', 'SANDALS', 'FLATS'],
  ACCESSORY: ['HAT', 'BELT', 'SCARF', 'JEWELRY', 'SUNGLASSES', 'WATCH'],
  BAG: ['HANDBAG', 'BACKPACK', 'TOTE', 'CLUTCH', 'CROSSBODY'],
};

/** Controlled colour tokens used by AI colour detection (WARDROBE-20). */
export const CLOTHING_COLOURS = [
  'BLACK',
  'WHITE',
  'GREY',
  'RED',
  'BLUE',
  'GREEN',
  'YELLOW',
  'ORANGE',
  'PINK',
  'PURPLE',
  'BROWN',
  'BEIGE',
  'NAVY',
  'CREAM',
  'GOLD',
  'SILVER',
  'BURGUNDY',
  'KHAKI',
  'TEAL',
  'OLIVE',
  'MULTICOLOUR',
] as const;

export type ClothingColour = (typeof CLOTHING_COLOURS)[number];

/** AI-only fields. Never overwrite user-set category / subcategory / colours. */
export interface GarmentAiMetadata {
  detectedCategory?: ClothingCategory;
  detectedSubcategory?: ClothingSubcategory;
  detectedColours?: ClothingColour[];
  backgroundRemoved?: boolean;
  processedImageKey?: string;
}

export type ProcessingStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';

export const PROCESS_WARDROBE_ITEM_JOB = 'PROCESS_WARDROBE_ITEM' as const;

export interface ProcessWardrobeItemJob {
  jobType: typeof PROCESS_WARDROBE_ITEM_JOB;
  userId: string;
  wardrobeId: string;
  itemId: string;
  originalImageKey: string;
}

/** Phase-3 AI profile types (WARDROBE-43). Flutter try-on picker uses these. */
export const AI_PROFILE_TYPES = ['PERSONAL', 'GENERIC_MODEL'] as const;
export type AiProfileType = (typeof AI_PROFILE_TYPES)[number];

/** Same status machine as clothing-item processing — no inference in this ticket. */
export const AI_PROFILE_STATUSES = [
  'PENDING',
  'PROCESSING',
  'READY',
  'FAILED',
] as const;
export type AiProfileStatus = (typeof AI_PROFILE_STATUSES)[number];

/**
 * Flutter `AiProfile` DTO. Never expose Dynamo `PK` / `SK` / `GSI1*`.
 *
 * `referenceImages` may be empty on create; WARDROBE-44 attaches uploads.
 * `label` is set on seeded GENERIC_MODEL rows (WARDROBE-45) for the picker.
 */
export interface AiProfile {
  aiProfileId: string;
  type: AiProfileType;
  referenceImages: string[];
  status: AiProfileStatus;
  createdAt: string;
  updatedAt: string;
  label?: string;
}

/** Flutter `AiProfileListResponse` for list / models picker. */
export interface AiProfileList {
  aiProfiles: AiProfile[];
}

/**
 * WARDROBE-44 hook — enqueue after reference-image attach when a worker exists.
 * This ticket documents the job shape only; it is not sent to SQS.
 */
export const PROCESS_AI_PROFILE_JOB = 'PROCESS_AI_PROFILE' as const;

export interface ProcessAiProfileJob {
  jobType: typeof PROCESS_AI_PROFILE_JOB;
  userId: string;
  aiProfileId: string;
}

/** WARDROBE-47 — async outfit try-on / render job. */
export const RENDER_OUTFIT_JOB = 'RENDER_OUTFIT' as const;

export interface RenderOutfitJob {
  jobType: typeof RENDER_OUTFIT_JOB;
  userId: string;
  wardrobeId: string;
  outfitId: string;
  aiProfileId: string;
}

export interface Wardrobe {
  wardrobeId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClothingItem {
  itemId: string;
  wardrobeId: string;
  name: string;
  category: ClothingCategory;
  subcategory?: string;
  colours?: string[];
  brand?: string;
  image?: {
    originalKey: string;
    processedKey?: string;
  };
  processingStatus: ProcessingStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Flutter `ItemListResponse` for `GET /wardrobes/{wardrobeId}/items`.
 *
 * Pagination can later add an opaque `nextCursor` string here.
 * Do not expose DynamoDB `LastEvaluatedKey`.
 */
export interface ClothingItemList {
  items: ClothingItem[];
}

export type OutfitSlot = ClothingCategory;

export interface OutfitItem {
  itemId: string;
  slot: OutfitSlot;
}

/** Same status machine as clothing-item processing (WARDROBE-47). */
export const RENDER_STATUSES = [
  'PENDING',
  'PROCESSING',
  'READY',
  'FAILED',
] as const;
export type RenderStatus = (typeof RENDER_STATUSES)[number];

/**
 * Flutter `OutfitRender` on the outfit (architecture §24).
 * `imageUrl` is a short-lived presigned GET — never persisted in Dynamo.
 */
export interface OutfitRender {
  status: RenderStatus;
  aiProfileId: string;
  imageKey?: string;
  imageUrl?: string;
  error?: string;
}

export interface Outfit {
  outfitId: string;
  wardrobeId: string;
  name: string;
  items: OutfitItem[];
  render?: OutfitRender;
  createdAt: string;
  updatedAt: string;
}

/** Suggested outfit. Flutter Outfit item shape (`itemId` + `slot`) without persist. */
export interface OutfitRecommendation {
  name?: string;
  items: OutfitItem[];
}

export interface OutfitRecommendationsResponse {
  recommendations: OutfitRecommendation[];
}

/**
 * Result of DELETE /me/content or DELETE /me.
 *
 * Firebase Auth is never deleted here. Flutter may keep the session after a
 * content wipe, or delete the Auth user client-side after DELETE /me.
 */
export interface UserWipeResult {
  keepAccount: boolean;
  deletedWardrobes: number;
  deletedItems: number;
  deletedOutfits: number;
  deletedAiProfiles: number;
  deletedS3Objects: number;
  s3Failures: number;
}

export type EntityType = 'PROFILE' | 'WARDROBE' | 'ITEM' | 'OUTFIT' | 'AIPROFILE';

export interface DynamoItem {
  PK: string;
  SK: string;
  entityType: EntityType;
  userId: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}
