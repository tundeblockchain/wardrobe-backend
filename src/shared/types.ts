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

export type ProcessingStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';

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

export interface OutfitItem {
  itemId: string;
  slot: string;
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
