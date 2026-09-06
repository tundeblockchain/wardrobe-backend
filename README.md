# Digital Wardrobe Backend

Serverless AWS backend for the Digital Wardrobe app. Infrastructure is defined with AWS CDK in TypeScript.

The Flutter app authenticates with Firebase. This API validates Firebase ID tokens and stores application data in AWS.

## What this starter includes

| Resource | Purpose |
| --- | --- |
| HTTP API Gateway | Public API with a Firebase Lambda authorizer |
| Lambda (domain handlers) | Health, me (clear content / delete account), wardrobes, items, outfits, recommendations, uploads, AI profiles, processing, outfit-render |
| DynamoDB | Single-table design (`PK` / `SK`) |
| S3 | Private media bucket with CORS for pre-signed uploads |
| SQS + DLQ | Async clothing-item processing + outfit try-on / render pipelines |
| CloudWatch | Lambda logs plus SQS depth, oldest-message, and DLQ alarms |
| Secrets Manager | Firebase project ID, Gemini background-removal, Gemini garment-classification, Gemini colour-detection, Gemini try-on, and OpenAI recommender credentials (placeholders) |

Working in this first cut:

- `GET /health` (no auth)
- `DELETE /me/content` and `DELETE /me` (clear content / delete account data)
- Wardrobe CRUD
- Clothing item CRUD (nested under a wardrobe); create enqueues `PROCESS_WARDROBE_ITEM` and returns `PENDING`
- Outfit CRUD (nested under a wardrobe) plus async try-on / render (`PENDING` → worker → `READY` / `FAILED`)
- Owner-only outfit recommendations (derived, never auto-saved)
- `POST /uploads` (S3 pre-signed PUT URL for clothing items)
- AI Profile CRUD plus PERSONAL reference-image presign/attach and seeded GENERIC_MODEL catalog
- Outfit try-on worker (Gemini `generateContent` image; writes `users/{uid}/outfits/{outfitId}/render.png`)
- Processing worker (Dynamo-validated `PENDING` → `PROCESSING` → `READY` / `FAILED`; background removal writes `processed.png`; classification and colour detection persist under `ai`)

## Prerequisites

- Node.js 20+
- AWS CLI configured with credentials
- An AWS account that can deploy CDK stacks
- A Firebase project (needed for authenticated routes)

## Setup

```bash
npm install
```

`cdk.json` is gitignored. Copy the example if you want a local file:

```bash
cp cdk.json.example cdk.json
```

If `cdk.json` is missing, `npm run synth` / `npm run deploy` generate it from `cdk.json.example`.

The Firebase project ID is stored in Secrets Manager, not CDK context. After the stack deploys, set the secret. Authenticated routes start working without another deploy (the authorizer reads the secret at runtime):

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/firebase-project-id \
  --secret-string "your-actual-firebase-project-id"
```

Background removal uses **Google Gemini** (`generateContent` image edit). After deploy, replace the generated placeholder with a Gemini API key. A plain key is enough (default model `gemini-2.5-flash-image`); JSON can override `model` and `endpoint`. Never commit the key.

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/gemini-background-removal \
  --secret-string '{"apiKey":"your-gemini-api-key","model":"gemini-2.5-flash-image"}'
```

A raw key string also works:

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/gemini-background-removal \
  --secret-string "your-gemini-api-key"
```

Optional CDK context / env `geminiModel` / `GEMINI_MODEL` and `geminiEndpoint` / `GEMINI_ENDPOINT` override the secret when you need a different Gemini image model or a proxy URL. The processing Lambda reads `BACKGROUND_REMOVAL_SECRET_ARN` at runtime.

Garment classification uses **Google Gemini** (`generateContent` image + text). After deploy, replace the generated placeholder with a Gemini API key. A plain key is enough (default model `gemini-2.5-flash`); JSON can override `model` and `endpoint`. Never commit the key.

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/gemini-classifier \
  --secret-string '{"apiKey":"your-gemini-api-key","model":"gemini-2.5-flash"}'
```

A raw key string also works:

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/gemini-classifier \
  --secret-string "your-gemini-api-key"
```

Optional CDK context / env `geminiClassifierModel` / `GEMINI_CLASSIFIER_MODEL` and `geminiClassifierEndpoint` / `GEMINI_CLASSIFIER_ENDPOINT` override the classifier secret when you need a different Gemini text+image model or a proxy URL. The processing Lambda reads `AI_CLASSIFIER_SECRET_ARN` at runtime. Do not reuse `GEMINI_MODEL` here — that override is for background-removal's image-edit model.

Colour / category detection uses **Google Gemini** (`generateContent` image+text). After deploy, replace the generated placeholder with a Gemini API key. A plain key is enough (default model `gemini-2.5-flash`); JSON can override `model` and `endpoint`. Never commit the key.

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/gemini-colour \
  --secret-string '{"apiKey":"your-gemini-api-key","model":"gemini-2.5-flash"}'
```

A raw key string also works:

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/gemini-colour \
  --secret-string "your-gemini-api-key"
```

The processing Lambda sets `COLOUR_DETECTOR_STRATEGY=gemini` by default. Override at synth/deploy with CDK context `colourDetectorStrategy` or env `COLOUR_DETECTOR_STRATEGY=http` to keep the vendor-agnostic HTTP hook. Optional `geminiColourModel` / `GEMINI_COLOUR_MODEL` and `geminiColourEndpoint` / `GEMINI_COLOUR_ENDPOINT` override the colour secret when you need a different Gemini text+vision model or a proxy URL. The processing Lambda reads `AI_COLOUR_DETECTOR_SECRET_ARN` at runtime.

Outfit recommendations (WARDROBE-28) default to OpenAI chat (`RECOMMENDER_STRATEGY=openai` on the recommendations Lambda). After deploy, replace the generated placeholder (never commit the key). A raw API key is enough; JSON may also set `model` / `endpoint`:

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/ai-recommender \
  --secret-string '{"apiKey":"sk-your-openai-key","model":"gpt-4o-mini"}'
```

```bash
# raw key also works — model defaults to gpt-4o-mini, endpoint to OpenAI chat completions
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/ai-recommender \
  --secret-string "sk-your-openai-key"
```

Virtual try-on / outfit render (WARDROBE-47) uses **Google Gemini** (`generateContent` image). After deploy, replace the generated placeholder with a Gemini API key. A plain key is enough (default model `gemini-2.5-flash-image`); JSON can override `model` and `endpoint`. Never commit the key.

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/gemini-try-on \
  --secret-string '{"apiKey":"your-gemini-api-key","model":"gemini-2.5-flash-image"}'
```

A raw key string also works:

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/gemini-try-on \
  --secret-string "your-gemini-api-key"
```

Optional CDK context / env `geminiTryOnModel` / `GEMINI_TRY_ON_MODEL` and `geminiTryOnEndpoint` / `GEMINI_TRY_ON_ENDPOINT` override the try-on secret when you need a different Gemini image model or a proxy URL. The outfit-render Lambda reads `GEMINI_TRY_ON_SECRET_ARN` at runtime. Do not reuse `GEMINI_MODEL` here — that override is for background-removal.

If this is the first CDK app in the account/region:

```bash
npx cdk bootstrap
```

## Deploy

```bash
npm run synth
npm run deploy
```

The deploy output includes `ApiUrl`. Health check:

```bash
curl https://{api-id}.execute-api.{region}.amazonaws.com/health
```

Authenticated calls need a Firebase ID token:

```http
Authorization: Bearer <firebase-id-token>
```

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://{api-id}.execute-api.{region}.amazonaws.com/wardrobes
```

## API

### Health

```http
GET /health
```

### Account (clear content / delete)

Identity comes from the Firebase authorizer (`getUserId`). Body or query `userId` is ignored.

```http
DELETE /me/content
DELETE /me
```

Both wipe the caller's wardrobes, items, outfits, and personal AI profiles in DynamoDB, then best-effort delete S3 objects under `users/{uid}/` (uploads, processed images, and future AI-profile refs). Seeded `GENERIC_MODEL` catalog rows are never deleted. Individual S3 failures are logged and counted; they do **not** fail the request if DynamoDB is clean. An already-empty account still returns `200`.

| Endpoint | Keeps Firebase Auth user | Flutter next step |
| --- | --- | --- |
| `DELETE /me/content` | Yes (`keepAccount: true`) | Session may stay; user starts with empty wardrobes |
| `DELETE /me` | Yes — this backend does **not** call Firebase Admin | Client deletes the Firebase Auth user after `200` |

Success body (`200`):

```json
{
  "keepAccount": true,
  "deletedWardrobes": 1,
  "deletedItems": 2,
  "deletedOutfits": 1,
  "deletedAiProfiles": 1,
  "deletedS3Objects": 3,
  "s3Failures": 0
}
```

`keepAccount` is `false` on `DELETE /me` (AWS data is gone; Firebase Auth remains until the client deletes it). Missing or invalid tokens return `401` `UNAUTHENTICATED`.

### Wardrobes

Identity comes from the Firebase authorizer (`getUserId`). Body/query/path `userId` is ignored.

```http
POST   /wardrobes
GET    /wardrobes
GET    /wardrobes/{wardrobeId}
PATCH  /wardrobes/{wardrobeId}
DELETE /wardrobes/{wardrobeId}
```

Create / update body (`name` required, trimmed, 1–100 characters):

```json
{ "name": "Summer Clothes" }
```

Create returns `201` with the Flutter DTO (`wardrobeId`, `name`, ISO 8601 `createdAt` / `updatedAt`). List returns `{ "wardrobes": [...] }`. Missing or other-user wardrobes return `404` `WARDROBE_NOT_FOUND`. Delete returns `204`.

### Uploads

```http
POST /uploads
```

```json
{
  "contentType": "image/jpeg",
  "purpose": "WARDROBE_ITEM",
  "contentLength": 2048
}
```

`contentType` must be `image/jpeg`, `image/png`, `image/webp`, or `image/heic`. `purpose` must be `WARDROBE_ITEM`. `contentLength` is optional; when sent it must be an integer from 1 to 10485760 (10MB) and is signed onto the S3 PUT so the object cannot exceed that exact size. The MVP max upload is 10MB either way.

Response (`UploadTicket`):

```json
{
  "uploadUrl": "https://...",
  "objectKey": "users/{uid}/uploads/{id}.jpg",
  "expiresIn": 900
}
```

Identity always comes from the Firebase token. A body `userId` is ignored.

The client then `PUT`s the image directly to `uploadUrl` with the same `Content-Type` (and `Content-Length` when it was declared). The media bucket stays private; the URL is time-limited.

### Clothing items

Identity comes from the Firebase authorizer (`getUserId`). The wardrobe must belong to that user before any item operation. Body or query `userId` is ignored.

```http
POST   /wardrobes/{wardrobeId}/items
GET    /wardrobes/{wardrobeId}/items
GET    /wardrobes/{wardrobeId}/items/{itemId}
PATCH  /wardrobes/{wardrobeId}/items/{itemId}
DELETE /wardrobes/{wardrobeId}/items/{itemId}
```

List supports optional smart filters (WARDROBE-21):

```http
GET /wardrobes/{wardrobeId}/items?category=TOP
GET /wardrobes/{wardrobeId}/items?category=TOP&colour=BLACK
GET /wardrobes/{wardrobeId}/items?category=TOP&colour=BLACK&subcategory=TSHIRT
```

- `category` — controlled `TOP | BOTTOM | DRESS | OUTERWEAR | SHOES | ACCESSORY | BAG`
- `colour` — controlled WARDROBE-20 tokens (`BLACK`, `WHITE`, `GREY`, `RED`, `BLUE`, `GREEN`, `YELLOW`, `ORANGE`, `PINK`, `PURPLE`, `BROWN`, `BEIGE`, `NAVY`, `CREAM`, `GOLD`, `SILVER`, `BURGUNDY`, `KHAKI`, `TEAL`, `OLIVE`, `MULTICOLOUR`)
- `subcategory` — optional controlled WARDROBE-19 token (`TSHIRT`, `JEANS`, …)

Filters are AND across query params. Within each param, matching is inclusive OR against the user field and AI metadata: `category` matches user `category` or `ai.detectedCategory`; `colour` matches user `colours` or `ai.detectedColours`; `subcategory` matches user `subcategory` or `ai.detectedSubcategory`. Unknown tokens return `400` `VALIDATION_ERROR`. List still returns Flutter `{ "items": [...] }` (no DynamoDB `LastEvaluatedKey`; an opaque `nextCursor` can be added later).

Create body (`name`, `category`, and `imageKey` required):

```json
{
  "name": "Black T-Shirt",
  "category": "TOP",
  "subcategory": "TSHIRT",
  "colours": ["BLACK"],
  "brand": "Nike",
  "imageKey": "users/{uid}/uploads/....jpg"
}
```

`category` must be one of `TOP`, `BOTTOM`, `DRESS`, `OUTERWEAR`, `SHOES`, `ACCESSORY`, `BAG`. `imageKey` must be under `users/{uid}/uploads/` or another path owned by the authenticated user.

Create writes the DynamoDB item first, then sends `PROCESS_WARDROBE_ITEM` to the processing queue (`{ jobType, userId, wardrobeId, itemId, originalImageKey }`). Identity in that message comes from the Firebase authorizer, never from a body `userId`. Create returns `201` with the Flutter `ClothingItem` DTO (`itemId`, `wardrobeId`, `name`, `category`, optional `subcategory` / `colours` / `brand`, `image.originalKey`, short-lived `originalImageUrl`, `processingStatus: PENDING`, ISO 8601 timestamps). If enqueue fails, the request fails with `500 INTERNAL_ERROR` and the item is rolled back so the client can retry. List and get use the same DTO (Flutter `ItemListResponse` is `{ "items": [...] }`). Missing or other-user wardrobes return `404` `WARDROBE_NOT_FOUND`. Missing items return `404` `ITEM_NOT_FOUND`. Delete returns `204`.

#### Clothing-item image URLs (WARDROBE-54)

The media bucket stays private. Create / list / get / PATCH return short-lived **presigned GET** URLs so Flutter can display photos without constructing S3 URLs. Existing `image.originalKey` / `image.processedKey` stay on the payload.

```json
{
  "itemId": "item_xyz123abcd",
  "wardrobeId": "wd_abc123xyz0",
  "name": "Black T-Shirt",
  "category": "TOP",
  "subcategory": "TSHIRT",
  "colours": ["BLACK"],
  "brand": "Nike",
  "image": {
    "originalKey": "users/{uid}/uploads/....jpg",
    "processedKey": "users/{uid}/items/{itemId}/processed.png"
  },
  "originalImageUrl": "https://...presigned GetObject for originalKey...",
  "processedImageUrl": "https://...presigned GetObject for processedKey...",
  "processingStatus": "READY",
  "createdAt": "2026-09-03T18:45:00.000Z",
  "updatedAt": "2026-09-03T18:45:00.000Z"
}
```

| Field | When present |
| --- | --- |
| `image.originalKey` | Whenever an original object key is stored |
| `originalImageUrl` | Whenever `originalKey` exists (`PENDING` / `PROCESSING` / `READY` / `FAILED`) — 15-minute (`expiresIn` **900**) presigned GET via `createPresignedGetUrl` |
| `image.processedKey` | After background removal writes `processed.png` (typically `READY`) |
| `processedImageUrl` | Whenever `processedKey` exists — same 900s presigned GET. Both URLs are returned when both keys exist so Flutter can prefer processed |

URLs are never written to Dynamo. A presign failure is logged and the URL is omitted; the rest of the item still returns `200` / `201`. Same TTL as `POST /uploads` (`expiresIn: 900`) and outfit `render.imageUrl`.

### Processing worker

The processing Lambda consumes `wardrobe-item-processing`. DynamoDB is the source of truth: the worker reloads the clothing item and checks `userId`, `wardrobeId`, `itemId`, and `originalImageKey` before doing work. It does not trust the SQS body alone.

Status machine:

```text
PENDING → PROCESSING → READY     pipeline success
        → FAILED                 permanent / validation errors
```

Poison messages (invalid JSON, unknown `jobType`, missing item, owner mismatch) are acked and dropped. An `originalImageKey` mismatch sets `FAILED` then acks.

Retries use the existing queue (WARDROBE-15): Lambda timeout **60s**, visibility timeout **120s** (visibility must stay greater than the timeout), `maxReceiveCount: 3`, then the DLQ + CloudWatch alarms. Retryable DynamoDB / provider / S3 errors are returned as SQS batch item failures so the message is redelivered.

Background removal (WARDROBE-26) reads the Dynamo-validated `originalImageKey` from the private media bucket, calls an injectable Gemini vision/image client (Secrets Manager credential; unit tests mock Gemini — no live Gemini calls in CI), writes `users/{userId}/items/{itemId}/processed.png`, and updates DynamoDB:

- `processedKey` — Flutter `ClothingItem.image.processedKey`
- `ai.backgroundRemoved = true`
- `ai.processedImageKey` — architecture metadata (merged into any existing `ai` map)

The original object is kept. Permanent Gemini / missing-image failures throw `PermanentProcessingError` so the worker sets `FAILED`. Transient failures throw `RetryableProcessingError` for SQS retry then DLQ.

Pipeline hooks:

1. Background removal (WARDROBE-26, Gemini) — implemented
2. AI classification (WARDROBE-19/27, Gemini) — injectable `generateContent` classifier; persists `ai.detectedCategory` / `ai.detectedSubcategory` only (never overwrites user `category` / `subcategory`)
3. Colour / category detection (WARDROBE-20 / WARDROBE-29) — injectable Gemini `generateContent` detector (deployed default). Persists `ai.detectedColours` (controlled tokens such as `BLACK`, `WHITE`, `RED`, `BLUE`) and may refine `ai.detectedCategory` / `ai.detectedSubcategory`. Never overwrites user-owned `category`, `subcategory`, or `colours`. Soft Gemini failures throw `PermanentProcessingError` / `RetryableProcessingError` so the worker sets `FAILED` or retries then DLQ — they never 500 the worker.

Classification and colour detection both use the processed image key when present (including the key just written by Gemini), otherwise the original. Credentials come from Secrets Manager (`wardrobe/{stage}/gemini-background-removal`, `wardrobe/{stage}/gemini-classifier`, and `wardrobe/{stage}/gemini-colour`); unit tests inject mock clients or use `COLOUR_DETECTOR_STRATEGY=http` and never call a live vision API. After deploy, replace the Gemini placeholders with API keys (or JSON `{"apiKey":"...","model":"..."}`) — do not commit AI keys.

Gemini classifier and colour-detector failures follow the existing worker degrade path: permanent errors (`PermanentProcessingError`) mark the item `FAILED` and ack; transient errors (`RetryableProcessingError`) are reported as SQS batch item failures for retry then DLQ. The worker does not 500.

The worker still sets `processingStatus: READY` after the full pipeline returns successfully, or `FAILED` on `PermanentProcessingError`. Transient failures throw `RetryableProcessingError` for SQS retry then DLQ.

### Outfits

Identity comes from the Firebase authorizer (`getUserId`). The wardrobe must belong to that user before any outfit operation. Every referenced `itemId` must already exist in that wardrobe. Body `userId` is ignored.

```http
POST   /wardrobes/{wardrobeId}/outfits
GET    /wardrobes/{wardrobeId}/outfits
GET    /wardrobes/{wardrobeId}/outfits/{outfitId}
PATCH  /wardrobes/{wardrobeId}/outfits/{outfitId}
DELETE /wardrobes/{wardrobeId}/outfits/{outfitId}
POST   /wardrobes/{wardrobeId}/outfits/{outfitId}/render
GET    /wardrobes/{wardrobeId}/outfits/{outfitId}/render
```

Create body (`name` and `items` required):

```json
{
  "name": "Friday Night",
  "items": [
    { "itemId": "item_...", "slot": "TOP" },
    { "itemId": "item_...", "slot": "BOTTOM" }
  ]
}
```

`name` is trimmed, 1–100 characters. `items` must contain at least one entry. `slot` must be one of `TOP`, `BOTTOM`, `DRESS`, `OUTERWEAR`, `SHOES`, `ACCESSORY`, `BAG`. `ACCESSORY` may appear more than once; other slots may appear only once. Duplicate `itemId` values are rejected.

Create returns `201` with the Flutter `Outfit` DTO (`outfitId`, `wardrobeId`, `name`, `items[{itemId, slot}]`, optional `render`, ISO 8601 `createdAt` / `updatedAt`). List returns `{ "outfits": [...] }`. Missing or other-user wardrobes return `404` `WARDROBE_NOT_FOUND`. Missing outfits return `404` `OUTFIT_NOT_FOUND`. Referenced items that are not in the wardrobe return `404` `ITEM_NOT_FOUND`. Delete returns `204`. Create / PATCH never accept a client-supplied `render` object.

### Outfit try-on / render (WARDROBE-47)

Identity comes from the Firebase authorizer (`getUserId`). Body / query / path `userId` is ignored. The outfit must belong to that user. The AI profile must be `READY` and readable: owner `PERSONAL`, or any authenticated user for shared `GENERIC_MODEL`.

```http
POST /wardrobes/{wardrobeId}/outfits/{outfitId}/render
GET  /wardrobes/{wardrobeId}/outfits/{outfitId}/render
```

Request body (`aiProfileId` required). Optional `items` replaces the outfit item set for this render (same `{itemId, slot}` shape as create). Optional `itemIds` selects a subset of the outfit's existing items (must already be on the outfit; use `items` to change slots):

```json
{
  "aiProfileId": "profile_generic_01",
  "items": [
    { "itemId": "item_...", "slot": "TOP" },
    { "itemId": "item_...", "slot": "BOTTOM" }
  ]
}
```

```text
POST /render
  → outfit.render.status = PENDING
  → SQS RENDER_OUTFIT
  → worker: PROCESSING → READY | FAILED
GET /render  (Flutter poll)
GET /wardrobes/{wardrobeId}/outfits/{outfitId}  (same render object)
```

POST returns `202` with the Flutter `Outfit` DTO including `render`. GET `/render` returns the Flutter `OutfitRender` record. GET outfit includes `render` when one has been requested. List includes `render` without `imageUrl` (use GET outfit or GET `/render` for the presigned URL).

```json
{
  "status": "READY",
  "aiProfileId": "profile_generic_01",
  "imageKey": "users/uid/outfits/outfit_xyz123ab/render.png",
  "imageUrl": "https://...presigned GetObject..."
}
```

| Field | When present |
| --- | --- |
| `status` | Always: `PENDING` \| `PROCESSING` \| `READY` \| `FAILED` |
| `aiProfileId` | Profile used for this request |
| `imageKey` | `READY` — S3 object `users/{uid}/outfits/{outfitId}/render.png` |
| `imageUrl` | `READY` on GET outfit / GET `/render` — 15-minute presigned GET |
| `error` | `FAILED` — human-readable reason (Gemini block, missing image, profile not READY, …) |

AuthZ / validation:

| Case | Response |
| --- | --- |
| Missing token | `401 UNAUTHENTICATED` |
| Other-user / missing wardrobe | `404 WARDROBE_NOT_FOUND` |
| Other-user / missing outfit | `404 OUTFIT_NOT_FOUND` |
| Unknown / other-user PERSONAL profile | `404 AI_PROFILE_NOT_FOUND` |
| Profile not `READY`, no reference images, item has no photo | `400 VALIDATION_ERROR` |
| GET `/render` before any POST | `404 RENDER_NOT_FOUND` |

The clothing-item worker is unchanged (`PROCESS_WARDROBE_ITEM` only). Try-on uses a dedicated queue `wardrobe-outfit-render-{stage}` + `OutfitRenderFn` so item-processing poison handling stays isolated.

**Worker:** Dynamo is the source of truth. It reloads the outfit (owner check), the profile (`getReadableAiProfile` + `READY` + reference images), and each garment (prefer `processedKey`, else `originalKey`). Gemini `generateContent` (image) writes `render.png`. Permanent Gemini / missing-image / profile errors set `FAILED` with `render.error` and ack. Transient errors are SQS batch failures (`maxReceiveCount: 3` then DLQ). Poison messages (invalid JSON, wrong `jobType`, missing fields) are acked.

**Secret** `wardrobe/{stage}/gemini-try-on` (stack output `GeminiTryOnSecretName`):

- raw API key, or
- JSON `{ "apiKey", "model?", "endpoint?" }` (`api_key` / `key` also accepted)

Default model `gemini-2.5-flash-image`. Never commit AI keys.

#### After deploy — Tunde console / secret steps

1. Deploy the stack (`npm run deploy` or the pipeline). Note `ApiUrl`, `MediaBucketName`, `GeminiTryOnSecretName`, `OutfitRenderQueueUrl`.
2. Populate the try-on secret (same Gemini key as background-removal is fine):

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/gemini-try-on \
  --secret-string '{"apiKey":"your-gemini-api-key","model":"gemini-2.5-flash-image"}'
```

CDK creates the secret as a placeholder. IAM: `OutfitRenderFn` may `secretsmanager:GetSecretValue` on this secret only. `OutfitsFn` may `sqs:SendMessage` on the try-on queue. The worker may consume the queue, `GetItem` / `Query` / `UpdateItem` on the table, and S3 read + put (no delete). No extra IAM console steps if you deploy via CDK.
3. Upload GENERIC_MODEL full-body photos if you have not already (WARDROBE-45 keys under `shared/ai-profiles/generic/{slug}/front.jpg`). A missing model photo marks the render `FAILED` with `Image not found: shared/ai-profiles/generic/...`.
4. Confirm: `POST .../outfits/{outfitId}/render` with `{ "aiProfileId": "profile_generic_01" }`, then poll `GET .../render` until `READY` or `FAILED`.
5. If messages land on `wardrobe-outfit-render-dlq-{stage}`, check CloudWatch alarm `wardrobe-outfit-render-dlq-{stage}` and the worker logs. After filling the secret, redrive or have Flutter retry POST.

### Outfit recommendations

Identity comes from the Firebase authorizer (`getUserId`). The wardrobe must belong to that user. Suggestions are derived from READY clothing items and are **never written** as outfits — Flutter can `POST /wardrobes/{wardrobeId}/outfits` if the user saves one.

```http
GET /wardrobes/{wardrobeId}/recommendations
```

GET is used because this is a read of derived suggestions (no request body, no persist). Missing or other-user wardrobes return `404` `WARDROBE_NOT_FOUND`. An empty wardrobe, or READY items that cannot form a wearable look (`TOP`+`BOTTOM`, or `DRESS`), returns `200` with `{ "recommendations": [] }` — never `500`.

Each suggestion uses the Flutter Outfit item shape (`itemId` + `slot` from `ClothingCategory`):

```json
{
  "recommendations": [
    {
      "name": "Navy + Beige look",
      "items": [
        { "itemId": "item_...", "slot": "TOP" },
        { "itemId": "item_...", "slot": "BOTTOM" },
        { "itemId": "item_...", "slot": "SHOES" }
      ]
    }
  ]
}
```

Category and colour come from AI metadata when present (`ai.detectedCategory`, `ai.detectedColours`) and otherwise fall back to the user-set `category` / `colours`. PENDING / PROCESSING / FAILED items are ignored.

**Strategy (`RECOMMENDER_STRATEGY`):**

| Value | Behaviour |
| --- | --- |
| `openai` (deployed default) | OpenAI chat completions via `wardrobe/{stage}/ai-recommender`. Invented item IDs are dropped. |
| `rules` (unset / tests) | Combinatorial silhouettes + colour compatibility. No vendor call. |
| `http` | Optional generic HTTP hook (`JSON { "apiKey", "endpoint" }`). |

The recommendations Lambda sets `RECOMMENDER_STRATEGY=openai`. Override at synth/deploy with CDK context `recommenderStrategy` or env `RECOMMENDER_STRATEGY` (`openai` / `rules` / `http`).

**OpenAI secret** `wardrobe/{stage}/ai-recommender`:

- raw API key, or
- JSON `{ "apiKey", "model?", "endpoint?" }` (`api_key` / `key` / `openaiApiKey` also accepted)

Defaults when omitted: model `gpt-4o-mini`, endpoint `https://api.openai.com/v1/chat/completions`. Never commit AI keys.

**Soft-failure policy:** OpenAI HTTP errors, timeouts, parse failures, missing/placeholder credentials, or an unusable response do **not** 500 the app. The handler falls back to the rule-based recommender and still returns `200`. Empty / insufficient READY items skip the vendor and return `{ "recommendations": [] }`.

Unit tests inject `fetchSecret` / `httpPost` (or the rule-based strategy) — no live OpenAI calls in CI.

## Auth

Identity always comes from the validated Firebase token (`sub` = Firebase UID). Clients must not send `userId` as proof of ownership.

A Lambda authorizer reads the Firebase project ID from Secrets Manager and validates the ID token:

- Issuer: `https://securetoken.google.com/<firebase-project-id>`
- Audience: `<firebase-project-id>`

## AI profiles (WARDROBE-43 / WARDROBE-44 / WARDROBE-45)

Phase-3 foundation. Separate from wardrobe CRUD. Outfit try-on / render is WARDROBE-47.

Identity comes from the Firebase authorizer (`getUserId`). Body/query/path `userId` is ignored.

```http
POST   /ai-profiles
GET    /ai-profiles
GET    /ai-profiles?type=PERSONAL
GET    /ai-profiles?type=GENERIC_MODEL
GET    /ai-profiles/models
GET    /ai-profiles/{aiProfileId}
DELETE /ai-profiles/{aiProfileId}
POST   /ai-profiles/{aiProfileId}/uploads
POST   /ai-profiles/{aiProfileId}/reference-images
```

| Route | Behaviour |
| --- | --- |
| `POST /ai-profiles` | Create a `PERSONAL` profile for the token UID. Body is optional. Starts `READY` with `referenceImages: []` (nothing to process yet). |
| `GET /ai-profiles` | List the caller's `PERSONAL` profiles. `?type=GENERIC_MODEL` lists the shared model catalog (same as `/models`). |
| `GET /ai-profiles/models` | Try-on picker: every seeded `GENERIC_MODEL` profile (WARDROBE-45). |
| `GET /ai-profiles/{aiProfileId}` | Owner-only for `PERSONAL`. Any authenticated user may read `GENERIC_MODEL`. Other-user personal profiles return `404 AI_PROFILE_NOT_FOUND` (no leak). |
| `DELETE /ai-profiles/{aiProfileId}` | Owner `PERSONAL` only (`204`). Users cannot delete `GENERIC_MODEL` (`403 UNAUTHORIZED`). |
| `POST /ai-profiles/{aiProfileId}/uploads` | Owner `PERSONAL` only. Returns a Flutter `UploadTicket` for a reference photo under `users/{uid}/ai-profiles/{aiProfileId}/`. |
| `POST /ai-profiles/{aiProfileId}/reference-images` | Owner `PERSONAL` only. Attach confirmed `objectKey`(s) into `referenceImages[]`. |

Create body (all fields optional):

```json
{
  "type": "PERSONAL",
  "referenceImages": []
}
```

- `type` — omit or `PERSONAL`. `GENERIC_MODEL` is rejected (`400`); those rows are seeded (WARDROBE-45).
- `referenceImages` — omit or `[]` on create. If sent, each key must be under `users/{uid}/`. Prefer the presign + attach flow below.
- Body `userId` / `status` are ignored.

Flutter `AiProfile` DTO (`201` / `200`) — never includes Dynamo `PK` / `SK` / `GSI1*` / `userId`:

```json
{
  "aiProfileId": "profile_abc123xyz0",
  "type": "PERSONAL",
  "referenceImages": [],
  "status": "READY",
  "createdAt": "2026-09-06T08:00:00.000Z",
  "updatedAt": "2026-09-06T08:00:00.000Z"
}
```

Seeded generic models also include optional `label` (picker display name). PERSONAL rows omit it.

List / models (`200`):

```json
{
  "aiProfiles": [
    {
      "aiProfileId": "profile_abc123xyz0",
      "type": "PERSONAL",
      "referenceImages": [],
      "status": "READY",
      "createdAt": "2026-09-06T08:00:00.000Z",
      "updatedAt": "2026-09-06T08:00:00.000Z"
    }
  ]
}
```

`type` is `PERSONAL` \| `GENERIC_MODEL`. `status` is `PENDING` \| `PROCESSING` \| `READY` \| `FAILED`.

Missing or other-user personal profiles return `404 AI_PROFILE_NOT_FOUND`. Missing tokens return `401 UNAUTHENTICATED`. Delete / upload / attach on a generic model returns `403 UNAUTHORIZED`.

### Reference-image upload (WARDROBE-44) — Flutter contract

Same pattern as clothing-item uploads (`POST /uploads`): the API never accepts image bytes. Flutter asks for a time-limited PUT URL, writes directly to the private media bucket, then confirms the key.

```text
POST /ai-profiles/{aiProfileId}/uploads
        │
        v
Lambda (owner PERSONAL only)
        │  S3 presigned PUT
        v
Flutter PUT image to uploadUrl
        │
        v
POST /ai-profiles/{aiProfileId}/reference-images
        │
        v
DynamoDB referenceImages[] + status READY
```

Presign request (`contentType` required; `contentLength` optional, 1–10485760):

```http
POST /ai-profiles/{aiProfileId}/uploads
```

```json
{
  "contentType": "image/jpeg",
  "purpose": "AI_PROFILE_REFERENCE",
  "contentLength": 2048
}
```

`contentType` must be `image/jpeg`, `image/png`, `image/webp`, or `image/heic`. `purpose` may be omitted; when sent it must be `AI_PROFILE_REFERENCE`. Body `userId` is ignored. The object key is always `users/{tokenUid}/ai-profiles/{aiProfileId}/{id}.{ext}` — never a body `userId`.

`201` `UploadTicket`:

```json
{
  "uploadUrl": "https://...",
  "objectKey": "users/{uid}/ai-profiles/{aiProfileId}/{id}.jpg",
  "expiresIn": 900
}
```

Flutter then `PUT`s the bytes to `uploadUrl` with the same `Content-Type` (and `Content-Length` when declared).

Confirm / attach (`objectKey` and/or `objectKeys`; at least one required):

```http
POST /ai-profiles/{aiProfileId}/reference-images
```

```json
{
  "objectKey": "users/{uid}/ai-profiles/{aiProfileId}/{id}.jpg"
}
```

or

```json
{
  "objectKeys": [
    "users/{uid}/ai-profiles/{aiProfileId}/{id}.jpg",
    "users/{uid}/ai-profiles/{aiProfileId}/{id}.png"
  ]
}
```

Rules:

- Owner `PERSONAL` only. Other-user personal → `404 AI_PROFILE_NOT_FOUND`. `GENERIC_MODEL` → `403 UNAUTHORIZED`.
- Each key must be a file directly under `users/{tokenUid}/ai-profiles/{aiProfileId}/`. Cross-user keys, wardrobe-item upload keys, and nested paths are `400 VALIDATION_ERROR`.
- Keys are appended (deduped, existing order kept). Combined list max is 10.
- `200` returns the updated Flutter `AiProfile` DTO.

`POST /uploads` stays clothing-item only (`purpose: WARDROBE_ITEM`). Do not send `AI_PROFILE_REFERENCE` there.

### Status transition

```text
POST /ai-profiles (empty refs)     READY
POST .../uploads                   no Dynamo write (status unchanged)
POST .../reference-images          READY   ← this ticket (no worker)

Future PROCESS_AI_PROFILE worker (not shipped):
  attach could return PENDING
  worker: PENDING → PROCESSING → READY | FAILED
```

This ticket does **not** enqueue `PROCESS_AI_PROFILE`. The clothing-item worker only accepts `PROCESS_WARDROBE_ITEM` and would drop any other job type as poison. The in-repo hook is `statusAfterReferenceImagesAttached()` (returns `READY`) plus `buildProcessAiProfileJob()`. A later worker ticket can flip attach to `PENDING` and enqueue that job.

### Generic models (WARDROBE-45)

Four `READY` `GENERIC_MODEL` profiles are written at deploy by a CDK custom resource (`GenericModelSeedFn`). IDs are stable so Flutter can cache them. Users still cannot `POST` or `DELETE` generic models (`400` / `403`). Account wipe never touches the catalog.

| `aiProfileId` | `label` | Placeholder S3 key |
| --- | --- | --- |
| `profile_generic_01` | Alex | `shared/ai-profiles/generic/alex/front.jpg` |
| `profile_generic_02` | Jordan | `shared/ai-profiles/generic/jordan/front.jpg` |
| `profile_generic_03` | Sam | `shared/ai-profiles/generic/sam/front.jpg` |
| `profile_generic_04` | Riley | `shared/ai-profiles/generic/riley/front.jpg` |

List (same payload from either route):

```http
GET /ai-profiles/models
GET /ai-profiles?type=GENERIC_MODEL
```

```json
{
  "aiProfiles": [
    {
      "aiProfileId": "profile_generic_01",
      "type": "GENERIC_MODEL",
      "label": "Alex",
      "referenceImages": ["shared/ai-profiles/generic/alex/front.jpg"],
      "status": "READY",
      "createdAt": "2026-09-06T00:00:00.000Z",
      "updatedAt": "2026-09-06T00:00:00.000Z"
    }
  ]
}
```

The seed writes Dynamo rows only. It does **not** upload image bytes. Keys above are documented placeholders under a shared prefix — never commit model photos or API keys.

#### After deploy — Tunde uploads real model images

1. Note `MediaBucketName` and `GenericModelCatalogIds` from the stack outputs.
2. Upload one full-body photo per model (JPEG/PNG/WebP/HEIC) to the exact placeholder key. Example:

```bash
BUCKET=$(aws cloudformation describe-stacks \
  --stack-name WardrobeStack-prod \
  --query "Stacks[0].Outputs[?OutputKey=='MediaBucketName'].OutputValue" \
  --output text)

aws s3 cp ./alex-front.jpg \
  "s3://$BUCKET/shared/ai-profiles/generic/alex/front.jpg" \
  --content-type image/jpeg

aws s3 cp ./jordan-front.jpg \
  "s3://$BUCKET/shared/ai-profiles/generic/jordan/front.jpg" \
  --content-type image/jpeg

aws s3 cp ./sam-front.jpg \
  "s3://$BUCKET/shared/ai-profiles/generic/sam/front.jpg" \
  --content-type image/jpeg

aws s3 cp ./riley-front.jpg \
  "s3://$BUCKET/shared/ai-profiles/generic/riley/front.jpg" \
  --content-type image/jpeg
```

3. Confirm the picker (Firebase ID token required):

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "$API_URL/ai-profiles/models"
```

Replacing an image in place (same key) does not require re-seeding. Adding a fifth model means editing `src/functions/ai-profiles/catalog.ts` (`GENERIC_MODEL_CATALOG_VERSION`) and redeploying, or putting a matching Dynamo row by hand.

#### Re-run the seed (CLI)

Idempotent. Preserves `createdAt`. Safe after a failed deploy or a manual row delete.

```bash
# uses TABLE_NAME when set; otherwise wardrobe-app-$STAGE (default stage=dev)
TABLE_NAME=wardrobe-app-prod npm run seed:generic-models
STAGE=prod npm run seed:generic-models
```

Requires AWS credentials that can `GetItem` / `PutItem` on `wardrobe-app-{stage}`.

#### Console fallback (no CLI)

In DynamoDB table `wardrobe-app-{stage}`, put an item:

```text
PK              AIPROFILE#GENERIC_MODEL
SK              AIPROFILE#profile_generic_01
GSI1PK          TYPE#GENERIC_MODEL
GSI1SK          AIPROFILE#profile_generic_01
entityType      AIPROFILE
userId          SYSTEM
aiProfileId     profile_generic_01
type            GENERIC_MODEL
label           Alex
status          READY
referenceImages ["shared/ai-profiles/generic/alex/front.jpg"]
createdAt       2026-09-06T00:00:00.000Z
updatedAt       2026-09-06T00:00:00.000Z
```

Repeat for `02`–`04`. `referenceImages` is a Dynamo string set or list of strings (this stack writes a list).

### Later-ticket hooks

| Ticket | Hook |
| --- | --- |
| WARDROBE-47 | Secret `wardrobe/{stage}/gemini-try-on` (`tryOnSecretName`). Job type `RENDER_OUTFIT` on the dedicated outfit-render queue. See **Outfit try-on / render** above. |

## DynamoDB keys

```text
PK                         SK                         GSI1PK                GSI1SK
USER#{uid}                 PROFILE
USER#{uid}                 WARDROBE#{wardrobeId}
USER#{uid}                 AIPROFILE#{aiProfileId}    (omitted — sparse)
WARDROBE#{wardrobeId}      ITEM#{itemId}
WARDROBE#{wardrobeId}      OUTFIT#{outfitId}
AIPROFILE#GENERIC_MODEL    AIPROFILE#{aiProfileId}    TYPE#GENERIC_MODEL    AIPROFILE#{aiProfileId}
```

Access patterns:

```text
List caller's PERSONAL profiles     Query PK=USER#{uid} begins_with SK=AIPROFILE#
Get caller's PERSONAL profile       Get USER#{uid} / AIPROFILE#{id}
List GENERIC_MODEL (picker)         Query GSI1 PK=TYPE#GENERIC_MODEL
                                    (fallback: Query PK=AIPROFILE#GENERIC_MODEL)
Get GENERIC_MODEL                   Get AIPROFILE#GENERIC_MODEL / AIPROFILE#{id}
```

API responses never expose `PK` / `SK` / `GSI1PK` / `GSI1SK`.

## Project layout

```text
bin/app.ts
lib/wardrobe-stack.ts
lib/support-mail.ts    isolated WARDROBE-38 Resend wiring (rebase-friendly)
lib/wardrobe-pipeline-stack.ts
lib/wardrobe-stage.ts
cdk.json.example
scripts/ensure-cdk-json.js
scripts/seed-generic-models.ts   idempotent GENERIC_MODEL catalog writer (WARDROBE-45)
src/functions/
  health/
  me/                  owner-only clear-content + delete-account (WARDROBE-36)
  wardrobes/
  items/
  outfits/             CRUD + POST/GET render (WARDROBE-47)
  recommendations/     owner-only derived outfits; OpenAI (default) + rule-based fallback
  uploads/
  ai-profiles/         CRUD + PERSONAL refs (43/44); generic catalog seed (45)
  processing/          Gemini helpers, bg-remove, classify, colour-detect, try-on, pipeline
  outfit-render/       SQS worker for RENDER_OUTFIT (WARDROBE-47)
  support/             WARDROBE-38 outbound contact/bug + Resend client + Svix verify
  support-webhook/     public inbound webhook entry (re-exports support/webhook)
src/shared/
  auth.ts
  dynamodb.ts
  errors.ts
  http.ts
  ids.ts
  logger.ts
  s3.ts
  secrets.ts
  sqs.ts
  types.ts
  validation.ts
```

## Environments

```bash
npm run deploy -- -c stage=staging
```

Then set `wardrobe/staging/firebase-project-id` in Secrets Manager.

Dev stacks use `RemovalPolicy.DESTROY` so `npx cdk destroy` can clean them up. Staging and production retain data.

## CI/CD pipeline

Pushes to `master` trigger an AWS CodePipeline that synths and deploys `WardrobeStack-prod`.

`cdk.json` is not in git. The pipeline rebuilds it in CodeBuild from `cdk.json.example` plus environment variables baked into the pipeline (`STAGE`, GitHub source settings). Synth also passes `--app`, so CDK does not need a committed `cdk.json`. The Firebase project ID stays in Secrets Manager.

### One-time setup

1. Create a GitHub repository and push this project to the `master` branch.
2. In AWS Developer Tools → Connections, create a GitHub connection and note the ARN.
3. Put the connection and repo details in your local `cdk.json` (or pass `-c` flags):

```json
{
  "context": {
    "githubOwner": "your-github-user",
    "githubRepo": "wardrobe-backend",
    "githubBranch": "master",
    "connectionArn": "arn:aws:codeconnections:REGION:ACCOUNT:connection/xxxxxxxx"
  }
}
```

4. Deploy the pipeline once from your machine:

```bash
npm run deploy:pipeline
```

After that, every push to `master` runs:

1. Source the repo through the CodeStar connection
2. `npm ci`
3. Write `cdk.json` from the example + pipeline env
4. `cdk synth --app "node -r ts-node/register/transpile-only bin/app.ts"`
5. Deploy `WardrobeStack-prod`

The first GitHub connection use may need a one-time handshake in the AWS console.

## Next

1. Phase-2 smart filtering (WARDROBE-21) and outfit recommendations (`GET /wardrobes/{wardrobeId}/recommendations`) are live
2. Phase-3 AI profiles (WARDROBE-43/44/45) and try-on render (WARDROBE-47) are live
3. Pagination and environment-specific alarms

## Support mail (WARDROBE-38)

Flutter **Contact us** / **Report a bug** forms POST through this API. Resend sends from a custom-domain address to Tunde’s mailbox. Inbound mail on that domain is webhook-forwarded to the same mailbox.

```text
Flutter (Firebase ID token)
   POST /support/contact  or  POST /support/bug
        │
        v
Support Lambda
        │  Secrets Manager
        │   wardrobe/{stage}/resend
        │   wardrobe/{stage}/support-mail
        v
Resend Send API
   from SUPPORT_FROM_EMAIL  →  SUPPORT_FORWARD_TO

Inbound mail @ custom domain
        │
        v
Resend  →  POST /webhooks/resend  (Svix-signed, no Firebase auth)
        │
        v
Support webhook Lambda
        │  verify svix-id / svix-timestamp / svix-signature
        │  GET /emails/receiving/{email_id}
        v
Resend Send API  (same from/to; Idempotency-Key inbound:{email_id})
```

Flutter UI is WARDROBE-34 (out of scope here). DNS is configured in the Resend dashboard by Tunde — this repo only documents the records and webhook URL.

### Flutter endpoint contracts

Both routes require the Firebase authorizer:

```http
Authorization: Bearer <firebase-id-token>
Content-Type: application/json
```

Identity comes from the token (`getUserId`). Body `userId` is ignored.

```http
POST /support/contact
POST /support/bug
```

```json
{
  "subject": "Can't upload a photo",
  "body": "The camera sheet hangs after I pick a photo.",
  "replyTo": "user@example.com",
  "meta": {
    "appVersion": "1.0.0",
    "platform": "ios",
    "deviceModel": "iPhone 15",
    "osVersion": "18.1"
  }
}
```

- `subject` — required, trimmed, 1–200 characters (newlines stripped)
- `body` — required, trimmed, 1–10000 characters
- `replyTo` — optional email; set as Resend `reply_to` when present
- `meta` — optional string map (max 20 keys) included in the mail footer

`202`:

```json
{ "status": "sent", "kind": "contact" }
```

`kind` is `contact` or `bug`. Resend’s message id is included as `id` when the Send API returns one.

Validation failures are `400 VALIDATION_ERROR`. Missing Firebase identity is `401 UNAUTHENTICATED`. Resend / secret failures are `500 INTERNAL_ERROR`.

Public inbound webhook (configure this URL in the Resend dashboard):

```http
POST /webhooks/resend
```

Resend signs the **raw** body with Standard Webhooks / Svix. The Lambda reads:

| Header | Mapped verify field |
| --- | --- |
| `svix-id` | `id` |
| `svix-timestamp` | `timestamp` |
| `svix-signature` | `signature` (`v1,<base64>`, space-separated during rotation) |

HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${rawBody}` using the `whsec_…` secret. Timestamps older than 5 minutes are rejected. Invalid signatures return `403 UNAUTHORIZED` (no Resend send). Other event types return `200 { "status": "ignored", "type": "…" }`. `email.received` fetches the body from `GET https://api.resend.com/emails/receiving/{email_id}` and forwards it; if that fetch fails, a metadata notification is still sent so mail is not silently dropped.

### Secret IDs and env wiring

Never commit API keys. CDK creates placeholders; replace them after deploy.

| Secret ID | JSON (or raw) | Runtime env on both support Lambdas |
| --- | --- | --- |
| `wardrobe/{stage}/resend` | `{ "apiKey", "webhookSecret" }` or a raw Resend API key | `RESEND_SECRET_ARN` |
| `wardrobe/{stage}/support-mail` | `{ "fromEmail", "forwardTo" }` | `SUPPORT_MAIL_SECRET_ARN` |

Conceptual keys (loaded from those secrets; env overrides win — useful in unit tests only):

| Key | Meaning |
| --- | --- |
| `RESEND_API_KEY` | Resend Send / Receiving API bearer token |
| `RESEND_WEBHOOK_SECRET` | Webhook signing secret (`whsec_…`) from the Resend webhook page |
| `SUPPORT_FROM_EMAIL` | Custom-domain From, e.g. `Wardrobe Support <support@your-domain>` |
| `SUPPORT_FORWARD_TO` | Tunde’s personal mailbox |

Lambdas never receive raw keys as environment variables in the deployed stack.

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/resend \
  --secret-string '{"apiKey":"re_your_key","webhookSecret":"whsec_your_signing_secret"}'
```

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/support-mail \
  --secret-string '{"fromEmail":"Wardrobe Support <support@your-domain>","forwardTo":"tunde@your-mailbox"}'
```

A raw API key also works for `wardrobe/{stage}/resend` if `webhookSecret` / addresses are supplied in the other secret or as test env vars. All four fields may live in one JSON blob on either secret.

Stack outputs: `ResendSecretName`, `SupportMailSecretName`, `SupportWebhookUrl`.

### Domain DNS (Tunde — do not configure from this PR)

In the Resend dashboard, add the custom sending + receiving domain and copy the DNS records Resend shows. Typical set:

| Record | Purpose |
| --- | --- |
| MX | Inbound receiving on the custom domain |
| TXT (SPF) | Authorize Resend to send for the domain |
| CNAME / TXT (DKIM) | Message signing (Resend publishes the exact names) |
| Optional DMARC TXT | Policy for unauthenticated mail |

Enable **receiving** on that domain. Create a webhook for `email.received` pointing at `{ApiUrl}/webhooks/resend` (the `SupportWebhookUrl` output). Paste the webhook’s `whsec_…` signing secret into `wardrobe/{stage}/resend`.

Do not put production Resend keys in git, `cdk.json`, or Lambda env literals.

Unit tests inject a mock Resend HTTP client and sign Svix fixtures locally — no live sends in CI.
