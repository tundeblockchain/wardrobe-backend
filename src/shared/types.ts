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

export type OutfitSlot = ClothingCategory;

export interface OutfitItem {
  itemId: string;
  slot: OutfitSlot;
}

export interface Outfit {
  outfitId: string;
  wardrobeId: string;
  name: string;
  items: OutfitItem[];
  createdAt: string;
  updatedAt: string;
}

export type EntityType = 'PROFILE' | 'WARDROBE' | 'ITEM' | 'OUTFIT';

export interface DynamoItem {
  PK: string;
  SK: string;
  entityType: EntityType;
  userId: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}
