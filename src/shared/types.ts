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

/**
 * Must match the clothing-item processing queue `maxReceiveCount` in
 * `lib/wardrobe-stack.ts`. After this many receives, Dynamo is marked
 * `FAILED` (WARDROBE-59) so Flutter is never stuck on `PROCESSING`.
 */
export const ITEM_PROCESSING_MAX_RECEIVE_COUNT = 3;

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
 * Optional body / context for Gemini try-on (WARDROBE-80 / WARDROBE-82).
 *
 * Same camelCase names in Dynamo, the Flutter DTO, and the try-on prompt.
 * Units are encoded in the field names (cm / kg / years). Soft-omit empty
 * values — none of these are required.
 *
 * `braSize` is free-form (e.g. `34B`, `32C`) — no stronger existing
 * convention (`cupSize` / `bra_size`) was found.
 */
export const AI_PROFILE_BODY_FIELD_NAMES = [
  'heightCm',
  'weightKg',
  'bustCm',
  'hipsCm',
  'clothingSize',
  'braSize',
  'ageYears',
  'bodyType',
  'gender',
] as const;

export type AiProfileBodyFieldName = (typeof AI_PROFILE_BODY_FIELD_NAMES)[number];

export interface AiProfileBodyContext {
  heightCm?: number;
  weightKg?: number;
  bustCm?: number;
  hipsCm?: number;
  clothingSize?: string;
  braSize?: string;
  ageYears?: number;
  bodyType?: string;
  gender?: string;
}

/**
 * Flutter `AiProfile` DTO. Never expose Dynamo `PK` / `SK` / `GSI1*`.
 *
 * `referenceImages` may be empty on create; WARDROBE-44 attaches uploads.
 * `label` is set on seeded GENERIC_MODEL rows (WARDROBE-45) for the picker.
 * `frontImageUrl` / `referenceImageUrls` are short-lived presigned GETs
 * (WARDROBE-73 / WARDROBE-79) — never persisted in Dynamo. Flutter
 * WARDROBE-71 reads `frontImageUrl`. PERSONAL rows coerce Dynamo Set /
 * `{ objectKey }` reference shapes onto the same field.
 * Optional body/context fields (WARDROBE-80 / WARDROBE-82) use the same
 * names in Dynamo and the try-on prompt. Flutter WARDROBE-81 / WARDROBE-83
 * should adopt these.
 */
export interface AiProfile extends AiProfileBodyContext {
  aiProfileId: string;
  type: AiProfileType;
  referenceImages: string[];
  status: AiProfileStatus;
  createdAt: string;
  updatedAt: string;
  label?: string;
  /**
   * Presigned GET for the frontal reference key. Present when that key
   * exists and presign succeeds. Soft-omitted on presign failure.
   */
  frontImageUrl?: string;
  /**
   * Presigned GETs for additional (non-frontal) `referenceImages` keys.
   * Map of objectKey → URL. Omitted when there are no extra angles or
   * those presigns fail.
   */
  referenceImageUrls?: Record<string, string>;
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
  /**
   * Per-request id (WARDROBE-85). Present on new POSTs so a second try-on
   * with the same profile appends history. Optional on in-flight legacy jobs.
   */
  renderId?: string;
}

/**
 * Terminal statuses written to the in-app job-done inbox (WARDROBE-114).
 * PENDING / PROCESSING never create events — Flutter still polls those.
 */
export const JOB_EVENT_STATUSES = ['READY', 'FAILED'] as const;
export type JobEventStatus = (typeof JOB_EVENT_STATUSES)[number];

/**
 * Async job types that emit a durable inbox event when they finish.
 * Values match existing SQS `jobType` fields. `PROCESS_AI_PROFILE` is not
 * enqueued today and does not emit events.
 */
export const JOB_EVENT_JOB_TYPES = [
  PROCESS_WARDROBE_ITEM_JOB,
  RENDER_OUTFIT_JOB,
] as const;
export type JobEventJobType = (typeof JOB_EVENT_JOB_TYPES)[number];

export const DEFAULT_JOB_EVENT_LIMIT = 20;
export const MAX_JOB_EVENT_LIMIT = 50;
/** Inbox rows expire after 30 days via the table `ttl` attribute. */
export const JOB_EVENT_TTL_SECONDS = 30 * 24 * 60 * 60;

export const DEVICE_PLATFORMS = ['IOS', 'ANDROID'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/**
 * Flutter `JobEvent` (WARDROBE-114 / Flutter WARDROBE-115).
 * Deep-link with `wardrobeId` + `itemId` or `outfitId` / `renderId`
 * plus `jobType` + `status`. Never expose Dynamo `PK` / `SK` or FCM tokens.
 */
export interface JobEvent {
  eventId: string;
  jobType: JobEventJobType;
  status: JobEventStatus;
  wardrobeId: string;
  itemId?: string;
  outfitId?: string;
  renderId?: string;
  aiProfileId?: string;
  /** Present on `FAILED`. Soft-omitted on `READY`. */
  error?: string;
  createdAt: string;
  /** Present after ack. Soft-omitted while unread. */
  acknowledgedAt?: string;
}

/** `GET /me/events` — newest first. */
export interface JobEventList {
  events: JobEvent[];
  unreadCount: number;
}

/** `POST /me/events/ack` */
export interface JobEventAckRequest {
  eventIds: string[];
}

export interface JobEventAckResponse {
  events: JobEvent[];
}

/**
 * Flutter device registration (WARDROBE-114). Token is write-only —
 * list/get never return it.
 */
export interface Device {
  deviceId: string;
  platform: DevicePlatform;
  updatedAt: string;
}

export interface Wardrobe {
  wardrobeId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Flutter `ClothingItem`. S3 keys stay on `image.*`.
 * `originalImageUrl` / `processedImageUrl` are short-lived presigned GETs
 * (WARDROBE-54) — never persisted in Dynamo.
 *
 * `acquiredAt` is an optional calendar date `YYYY-MM-DD` (WARDROBE-92).
 * Soft-omitted when unset. Flutter WARDROBE-93 should use this name.
 */
export interface ClothingItem {
  itemId: string;
  wardrobeId: string;
  name: string;
  category: ClothingCategory;
  subcategory?: string;
  colours?: string[];
  brand?: string;
  /**
   * Optional purchased / acquired calendar date (`YYYY-MM-DD`).
   * Present only when stored. Never `null`.
   */
  acquiredAt?: string;
  image?: {
    originalKey: string;
    processedKey?: string;
  };
  /** Presigned GET for `image.originalKey`. Present whenever that key exists. */
  originalImageUrl?: string;
  /** Presigned GET for `image.processedKey`. Present when a processed object exists. */
  processedImageUrl?: string;
  processingStatus: ProcessingStatus;
  /**
   * Present on `FAILED` (WARDROBE-59). Short worker reason for Flutter.
   * Omitted on PENDING / PROCESSING / READY.
   */
  processingError?: string;
  /**
   * Current Virtual Try On on this item (WARDROBE-149 / WARDROBE-150).
   * Same shape as outfit `render`. Soft-omitted when unset. Generate is
   * WARDROBE-150 — this ticket only deletes stored photos.
   */
  render?: OutfitRender;
  /**
   * Successful item try-ons, newest first. Same shape as outfit
   * `renderHistory`. Soft-omitted when empty.
   */
  renderHistory?: OutfitRenderHistoryEntry[];
  /** Presigned GET URLs for item try-ons, newest first. Soft-omitted when empty. */
  renderImageUrls?: string[];
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
 * Flutter `OutfitRender` on the outfit (architecture §24 / WARDROBE-47).
 * `imageUrl` is a short-lived presigned GET — never persisted in Dynamo.
 * WARDROBE-85 keeps these fields as the current / latest try-on.
 */
export interface OutfitRender {
  status: RenderStatus;
  aiProfileId: string;
  imageKey?: string;
  imageUrl?: string;
  error?: string;
}

/**
 * One successful try-on in append-only history (WARDROBE-85).
 * Stored in Dynamo without `imageUrl`. List/get add a presigned GET
 * and soft-omit that field when presign fails.
 */
export interface OutfitRenderHistoryEntry {
  imageKey: string;
  createdAt: string;
  aiProfileId: string;
  imageUrl?: string;
}

export interface Outfit {
  outfitId: string;
  wardrobeId: string;
  name: string;
  items: OutfitItem[];
  render?: OutfitRender;
  /**
   * Successful try-ons, newest first (WARDROBE-85 / Flutter WARDROBE-84).
   * Includes the latest READY image. Soft-omitted when empty.
   * DELETE .../renders removes one entry by `imageKey` (WARDROBE-149).
   */
  renderHistory?: OutfitRenderHistoryEntry[];
  /**
   * Presigned GET URLs for successful try-ons, newest first.
   * `[0]` is the latest when that presign succeeded.
   * Soft-omitted when empty (no history or every presign failed).
   */
  renderImageUrls?: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * One date-only “worn on” log entry (WARDROBE-120 / Flutter WARDROBE-121).
 * `wornOn` is a calendar date `YYYY-MM-DD`, not a datetime.
 * Soft-omit unused optionals — never send JSON `null`.
 */
export interface OutfitWornOn {
  outfitId: string;
  wardrobeId: string;
  wornOn: string;
  createdAt: string;
}

/** Flutter list / calendar payload for worn-on dates. */
export interface OutfitWornOnList {
  entries: OutfitWornOn[];
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
 * Flutter shopping-link card (WARDROBE-96 / WARDROBE-95).
 * Soft-omit unset optional fields — never send `null`.
 */
export interface ShoppingLink {
  title: string;
  url: string;
  merchant?: string;
  price?: string;
  currency?: string;
  imageUrl?: string;
}

export interface ShoppingLinksWarning {
  code: 'SHOPPING_UPSTREAM_UNAVAILABLE';
  message: string;
}

/** One clothing item’s related shopping section (item detail or Home row). */
export interface ShoppingLinksItemResult {
  itemId: string;
  wardrobeId: string;
  keywords: string[];
  cached: boolean;
  links: ShoppingLink[];
  warning?: ShoppingLinksWarning;
}

/** `GET /wardrobes/{wardrobeId}/items/{itemId}/shopping-links` */
export type ItemShoppingLinksResponse = ShoppingLinksItemResult;

/** `GET /shopping-links` — mixed recent items across the caller’s wardrobes. */
export interface HomeShoppingLinksResponse {
  items: ShoppingLinksItemResult[];
}

export const SHOPPING_UPSTREAM_WARNING_CODE =
  'SHOPPING_UPSTREAM_UNAVAILABLE' as const;

export const SHOPPING_LINKS_CACHE_TTL_SECONDS = 24 * 60 * 60;

export const DEFAULT_SHOPPING_HOME_LIMIT = 5;
export const MAX_SHOPPING_HOME_LIMIT = 10;
export const DEFAULT_SHOPPING_LINKS_PER_ITEM = 8;
export const MAX_SHOPPING_LINKS_PER_ITEM = 12;

/**
 * Result of DELETE /me/content (WARDROBE-36). DELETE /me (WARDROBE-103)
 * returns {@link AccountDeleteResult} instead.
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

/**
 * Store-cancel outcome on DELETE /me (WARDROBE-103 / Flutter WARDROBE-102).
 * Soft-omit unset optional fields; never send JSON `null`.
 */
export const SUBSCRIPTION_CANCEL_STATUSES = [
  'NONE',
  'CANCELED',
  'CANCEL_AT_PERIOD_END',
  'CANCEL_FAILED',
] as const;
export type SubscriptionCancelStatus =
  (typeof SUBSCRIPTION_CANCEL_STATUSES)[number];

export const SUBSCRIPTION_CANCEL_MODES = ['IMMEDIATE', 'PERIOD_END'] as const;
export type SubscriptionCancelMode = (typeof SUBSCRIPTION_CANCEL_MODES)[number];

export interface SubscriptionCancelResult {
  status: SubscriptionCancelStatus;
  cancelMode?: SubscriptionCancelMode;
  store?: EntitlementStore;
  expiresAt?: string;
  /** Present when Flutter should open App Store / Play subscription settings. */
  retryInStore?: boolean;
}

/**
 * Result of DELETE /me (WARDROBE-103). Wipe counts stay for WARDROBE-36
 * clients; Flutter WARDROBE-102 may ignore them.
 */
export interface AccountDeleteResult extends UserWipeResult {
  deleted: true;
  keepAccount: false;
  entitlementRevoked: true;
  subscription: SubscriptionCancelResult;
}

/**
 * Subscription tier (WARDROBE-91). Flutter WARDROBE-90 uses the same enum.
 * Missing / expired / unknown store rows resolve to FREE.
 */
export const SUBSCRIPTION_TIERS = ['FREE', 'BASIC', 'PREMIUM'] as const;
export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

export const ENTITLEMENT_STATUSES = [
  'NONE',
  'ACTIVE',
  'CANCELED',
  'BILLING_ISSUE',
  'PAUSED',
  'EXPIRED',
] as const;
export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];

export const ENTITLEMENT_STORES = [
  'APP_STORE',
  'PLAY_STORE',
  'STRIPE',
  'UNKNOWN',
] as const;
export type EntitlementStore = (typeof ENTITLEMENT_STORES)[number];

export const ENTITLEMENT_PERIODS = ['MONTHLY', 'YEARLY', 'UNKNOWN'] as const;
export type EntitlementPeriod = (typeof ENTITLEMENT_PERIODS)[number];

/** Free catalog caps. Basic and Premium are unlimited (`limits: null`). */
export const FREE_CATALOG_LIMITS = {
  wardrobes: 1,
  items: 5,
  outfits: 5,
} as const;

export interface EntitlementLimits {
  wardrobes: number;
  items: number;
  outfits: number;
}

export interface EntitlementUsage {
  wardrobes: number;
  items: number;
  outfits: number;
}

export interface EntitlementFeatures {
  /** True on Basic and Premium (unlimited wardrobes / items / outfits). */
  unlimitedCatalog: boolean;
  /** Virtual try-on / outfit render. Premium only. */
  aiTryOn: boolean;
  /** Classify, colour, bg-removal enqueue, recommendations. Premium only. */
  otherAi: boolean;
}

/**
 * Flutter `Entitlement` DTO for `GET /me` (WARDROBE-91 / WARDROBE-90).
 * Never includes Dynamo `PK` / `SK` / internal event ids.
 */
export interface Entitlement {
  userId: string;
  tier: SubscriptionTier;
  status: EntitlementStatus;
  features: EntitlementFeatures;
  /**
   * Catalog caps. `null` means unlimited (Basic / Premium).
   * Free: 1 wardrobe, 5 items, 5 outfits.
   */
  limits: EntitlementLimits | null;
  usage: EntitlementUsage;
  /**
   * Store product identifier when known. Hooks only — App Store / Play
   * IDs are operator-configured in Secrets Manager, never hardcoded.
   */
  productId?: string;
  store?: EntitlementStore;
  period?: EntitlementPeriod;
  /** ISO 8601. Present when Superwall sent `expirationAt`. */
  expiresAt?: string;
  updatedAt: string;
}

export const SHARE_RESOURCE_TYPES = ['ITEM', 'OUTFIT'] as const;
export type ShareResourceType = (typeof SHARE_RESOURCE_TYPES)[number];

/** Default share-link lifetime (WARDROBE-126). Dynamo `ttl` matches `expiresAt`. */
export const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Owner create / revoke DTO (WARDROBE-126 / Flutter WARDROBE-128 /
 * Frontend WARDROBE-127). Never includes `userId` or Dynamo keys.
 * Soft-omit unused `itemId` / `outfitId` — never JSON `null`.
 *
 * `sharePath` is a **relative path only** (`/share/{token}`). This backend
 * never invents or hardcodes an absolute public URL. Flutter WARDROBE-128
 * and Frontend WARDROBE-127 compose:
 * `{landing-site base from their env}{sharePath}`.
 */
export interface Share {
  token: string;
  resourceType: ShareResourceType;
  wardrobeId: string;
  itemId?: string;
  outfitId?: string;
  /**
   * Relative path only, e.g. `/share/shr_…`.
   * Never an absolute URL. Clients prepend their landing-site base.
   */
  sharePath: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * Public preview (no auth). Never includes firebase uid, wardrobe lists,
 * other items, or private profile fields.
 */
export interface SharePreview {
  resourceType: ShareResourceType;
  title: string;
  /** Short-lived presigned GET. Soft-omitted when no image or presign fails. */
  imageUrl?: string;
  expiresAt: string;
}

export type EntityType =
  | 'PROFILE'
  | 'WARDROBE'
  | 'ITEM'
  | 'OUTFIT'
  | 'WORN_ON'
  | 'AIPROFILE'
  | 'ENTITLEMENT'
  | 'SHOPPING_CACHE'
  | 'JOB_EVENT'
  | 'DEVICE'
  | 'SHARE'
  | 'RATE_LIMIT';

export interface DynamoItem {
  PK: string;
  SK: string;
  entityType: EntityType;
  userId: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}
