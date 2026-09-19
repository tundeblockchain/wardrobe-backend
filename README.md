# Digital Wardrobe Backend

Serverless AWS backend for the Digital Wardrobe app. Infrastructure is defined with AWS CDK in TypeScript.

The Flutter app authenticates with Firebase. This API validates Firebase ID tokens and stores application data in AWS.

## What this starter includes

| Resource | Purpose |
| --- | --- |
| HTTP API Gateway | Public API with a Firebase Lambda authorizer |
| Lambda (domain handlers) | Health, me (entitlement / clear content / delete account), events (job-done inbox + FCM devices), wardrobes, items, outfits, shares (item/outfit share tokens + public preview), recommendations, shopping-links, uploads, AI profiles, processing, outfit-render, Superwall entitlements webhook |
| DynamoDB | Single-table design (`PK` / `SK`) |
| S3 | Private media bucket with CORS for pre-signed uploads |
| SQS + DLQ | Async clothing-item processing + outfit try-on / render pipelines |
| CloudWatch | Lambda logs plus SQS depth, oldest-message, and DLQ alarms |
| Secrets Manager | Firebase project ID, optional Firebase FCM service account, Gemini background-removal, Gemini garment-classification, Gemini colour-detection, Gemini try-on, OpenAI recommender, OpenAI shopping keywords, Bright Data SERP, Resend support mail, and Superwall webhook credentials (placeholders) |

Working in this first cut:

- `GET /health` (no auth)
- `GET /me` (entitlement for Flutter WARDROBE-90)
- `DELETE /me/content` (clear content; keeps account + entitlement)
- `DELETE /me` (cancel subscription when possible, revoke entitlement, delete account data; Flutter WARDROBE-102)
- `POST /webhooks/superwall` (Svix-signed Superwall subscription updates; no Firebase auth)
- Wardrobe CRUD
- Clothing item CRUD (nested under a wardrobe); create enqueues `PROCESS_WARDROBE_ITEM` and returns `PENDING`; `POST .../items/{itemId}/reprocess` re-enqueues a `FAILED` item (WARDROBE-123)
- Move / copy a clothing item to another owned wardrobe (WARDROBE-118; Flutter WARDROBE-119)
- Outfit CRUD (nested under a wardrobe) plus async try-on / render (`PENDING` → worker → `READY` / `FAILED`)
- Outfit worn-on log (date-only entries for calendar / habit; Flutter WARDROBE-121)
- Owner-only outfit recommendations (derived, never auto-saved)
- Related shopping links (OpenAI image→keywords + Bright Data SERP; Free/Basic/Premium — not entitlement-gated)
- Share links for a single clothing item or outfit (WARDROBE-126; Flutter WARDROBE-128 / Frontend WARDROBE-127). Growth feature — Free/Basic/Premium, not entitlement-gated. Public preview is unauthenticated.
- `POST /uploads` (S3 pre-signed PUT URL for clothing items)
- AI Profile CRUD plus PERSONAL reference-image presign/attach, seeded GENERIC_MODEL catalog, and short-lived `frontImageUrl` on list/get (WARDROBE-73)
- Outfit try-on worker (Gemini `generateContent` image; writes a unique `users/{uid}/outfits/{outfitId}/renders/{renderId}.png` and appends it to outfit history)
- Processing worker (Dynamo-validated `PENDING` → `PROCESSING` → `READY` / `FAILED`; exhausted retries and the DLQ write `FAILED` so Flutter is never stuck on `PROCESSING`; background removal writes `processed.png`; classification and colour detection persist under `ai`)
- Job-done inbox (`GET /me/events` + ack) so Flutter can stop blind-polling when item processing or try-on finishes (WARDROBE-114 / Flutter WARDROBE-115). Optional FCM push when `wardrobe/{stage}/firebase-fcm` is a real service-account JSON.

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

Optional FCM job-done push (WARDROBE-114) uses a **different** secret. The authorizer only needs the project ID. Push needs a Firebase **service-account JSON** (FCM HTTP v1). The in-app event API works if you leave the generated placeholder — workers skip push and never 5xx. Never commit the JSON.

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/firebase-fcm \
  --secret-string file://firebase-fcm-service-account.json
```

Standard Google fields (`project_id`, `client_email`, `private_key`) or camelCase (`projectId`, `clientEmail`, `privateKey`) are accepted. The processing and outfit-render Lambdas read `FIREBASE_FCM_SECRET_ARN` at runtime.

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

**Background removal is off by default** (`BACKGROUND_REMOVAL_ENABLED=false`, WARDROBE-62). Gemini image-edit often returns no image, which used to fail add-item with `Gemini did not return an image for background removal.` When the flag is off the worker skips Gemini bg-removal entirely, does not fail the item for that reason, and continues classify / colour using the **original** image. The item still reaches `READY` with `originalKey` / `originalImageUrl`.

To turn background removal **on** for a deployed stage (after Reviewer squash-merge + your deploy):

```bash
# At synth/deploy (preferred — survives the next CDK deploy)
BACKGROUND_REMOVAL_ENABLED=true npm run deploy -- -c stage=prod
# or
npx cdk deploy --app "node -r ts-node/register/transpile-only bin/app.ts" \
  -c stage=prod -c backgroundRemovalEnabled=true
```

Console fallback (overwritten the next time you deploy unless CDK context/env is also set): AWS Lambda → `ProcessingFn` → Configuration → Environment variables → set `BACKGROUND_REMOVAL_ENABLED` to `true`. Allowed on values: `true`, `1`, `yes`, `on` (case-insensitive). Anything else, including unset, is off.

Garment classification uses **Google Gemini** (`generateContent` image + text). After deploy, replace the generated placeholder with a Gemini API key. The classifier secret is **API key only** — do not add a `model` field and do not edit the secret to pick a model. Classify is hardcoded to `gemini-3.1-flash-lite` (`/v1beta/models/gemini-3.1-flash-lite:generateContent`). It does not remap onto Gemini 2.5 (`gemini-2.5-flash` / `gemini-2.5-flash-lite` 404 for new API keys). The request matches Interior-design-backend: `?key=` query auth and `content-type: application/json` only (no `x-goog-api-key`). Never commit the key.

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/gemini-classifier \
  --secret-string "your-gemini-api-key"
```

Optional CDK context / env `geminiClassifierEndpoint` / `GEMINI_CLASSIFIER_ENDPOINT` keeps a custom (non-Google) proxy URL. The processing Lambda reads `AI_CLASSIFIER_SECRET_ARN` at runtime. Do not reuse `GEMINI_MODEL` here — that override is for background-removal's image-edit model.

Colour / category detection uses **Google Gemini** (`generateContent` image+text). After deploy, replace the generated placeholder with a Gemini API key. The colour secret is **API key only** — same hardcoded model as classify (`gemini-3.1-flash-lite`). Never commit the key.

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/gemini-colour \
  --secret-string "your-gemini-api-key"
```

The processing Lambda sets `COLOUR_DETECTOR_STRATEGY=gemini` by default. Override at synth/deploy with CDK context `colourDetectorStrategy` or env `COLOUR_DETECTOR_STRATEGY=http` to keep the vendor-agnostic HTTP hook. Optional `geminiColourEndpoint` / `GEMINI_COLOUR_ENDPOINT` keeps a custom proxy URL. The processing Lambda reads `AI_COLOUR_DETECTOR_SECRET_ARN` at runtime.

Outfit recommendations (WARDROBE-28) default to OpenAI chat (`RECOMMENDER_STRATEGY=openai` on the recommendations Lambda). After deploy, replace the generated placeholder (never commit the key). A raw API key is enough; JSON may also set `model` / `endpoint`:

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/ai-recommender \
  --secret-string '{"apiKey":"sk-your-openai-key","model":"gpt-4.1-mini"}'
```

```bash
# raw key also works — model defaults to gpt-4.1-mini, endpoint to OpenAI chat completions
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/ai-recommender \
  --secret-string "sk-your-openai-key"
```

Virtual try-on / outfit render (WARDROBE-47) uses **Google Gemini** (`generateContent` image). After deploy, replace the generated placeholder with a Gemini API key. A plain key is enough (default model `gemini-3.1-flash-image`); JSON can override `model` and `endpoint`. Never commit the key.

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/gemini-try-on \
  --secret-string '{"apiKey":"your-gemini-api-key","model":"gemini-3.1-flash-image"}'
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

### Account (entitlement / clear content / delete)

Identity comes from the Firebase authorizer (`getUserId`). Body or query `userId` is ignored.

```http
GET    /me
DELETE /me/content
DELETE /me
GET    /me/events
POST   /me/events/ack
POST   /me/events/{eventId}/ack
PUT    /me/devices
DELETE /me/devices/{deviceId}
```

`GET /me` returns the Flutter entitlement DTO (WARDROBE-91). See **Entitlements** below.

`DELETE` wipes the caller's wardrobes, items, outfits, worn-on dates, personal AI profiles, job-done events, FCM device tokens, and share-link tokens in DynamoDB, then best-effort delete S3 objects under `users/{uid}/` (uploads, processed images, and future AI-profile refs). Seeded `GENERIC_MODEL` catalog rows are never deleted. Individual S3 failures are logged and counted; they do **not** fail the request if DynamoDB is clean. An already-empty account still returns `200`. Hard Dynamo / S3 setup failures return `500` `INTERNAL_ERROR`. Missing or invalid tokens return `401` `UNAUTHENTICATED`.

Job-done inbox and device registration (WARDROBE-114 / Flutter WARDROBE-115) are documented under **AI job-done events**.

| Endpoint | Keeps Firebase Auth user | Keeps entitlement | Cancels store subscription | Flutter next step |
| --- | --- | --- | --- | --- |
| `DELETE /me/content` | Yes (`keepAccount: true`) | Yes | No | Session may stay; user starts with empty wardrobes |
| `DELETE /me` | Yes — this backend does **not** call Firebase Admin | No (revoked before wipe) | Yes, best-effort | Handle `subscription.status`, then delete Firebase Auth when `deleted: true` |

Success body (`200`) for **`DELETE /me/content`** is unchanged (WARDROBE-36):

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

#### Account delete + subscription cancel (WARDROBE-103) — Flutter WARDROBE-102 contract

```http
DELETE /me
Authorization: Bearer <firebase-id-token>
```

No body. Always attempt subscription cancel + entitlement revoke **before** wiping AWS user data.

Server order:

1. Load `USER#{uid}/ENTITLEMENT` if present.
2. Attempt cancel via store APIs for that user (**prefer immediate cancel**). Superwall has no cancel API (its V2 API is project/paywall management; the existing webhook only *writes* `ENTITLEMENT`). If only cancel-at-period-end is available, do that — still revoke Premium server-side immediately.
3. Revoke server entitlement (delete the `ENTITLEMENT` row) so `GET /me` and `ENTITLEMENT_*` cannot grant paid features after delete.
4. Delete AWS account data (existing `DELETE /me` wipe: Dynamo + S3; not Firebase Auth).
5. Return `200` with the outcome. Client deletes Firebase Auth (this backend still has no Admin SDK).

`200` body (soft-omit unset optional fields; never send JSON `null`):

```json
{
  "deleted": true,
  "keepAccount": false,
  "entitlementRevoked": true,
  "subscription": {
    "status": "NONE",
    "cancelMode": "IMMEDIATE",
    "store": "APP_STORE",
    "expiresAt": "2026-10-01T00:00:00.000Z",
    "retryInStore": false
  }
}
```

`subscription.status`: `NONE` | `CANCELED` | `CANCEL_AT_PERIOD_END` | `CANCEL_FAILED`

| `status` | Meaning | `retryInStore` |
| --- | --- | --- |
| `NONE` | No billing row (or already expired). Nothing to cancel. | omitted |
| `CANCELED` | Store cancel succeeded immediately, or Superwall already marked `CANCELED`. | omitted |
| `CANCEL_AT_PERIOD_END` | Store only supports stop-renewal (Play cancel fallback). Server entitlement is still revoked now. | omitted |
| `CANCEL_FAILED` | Store cancel did not succeed. Account data is still deleted and entitlement revoked. | `true` |

Optional `cancelMode` (`IMMEDIATE` \| `PERIOD_END`), `store`, and `expiresAt` are omitted when unknown. `retryInStore` is sent only when `true`. Wipe counts from WARDROBE-36 (`deletedWardrobes`, …) are still included; Flutter WARDROBE-102 may ignore them.

Flutter WARDROBE-102:

1. Call `DELETE /me`.
2. On `subscription.status` `CANCEL_FAILED` or `CANCEL_AT_PERIOD_END`, show App Store / Play manage-subscription copy (`retryInStore: true` on failure).
3. When `deleted: true`, delete the Firebase Auth user. Server revoke is the source of truth for API gates — a deleted account cannot use Premium even if the store keeps billing until the user cancels in Settings.

`DELETE /me/content` is **unchanged** (keeps account + entitlement; no cancel).

Store cancel capabilities (do not invent product IDs):

| Store | Server cancel? | What this stack does |
| --- | --- | --- |
| Superwall | No cancel API | Webhook already writes `ENTITLEMENT`. Not used to cancel. |
| App Store | No developer-initiated cancel (user must use Settings → Subscriptions) | Skip HTTP. `CANCEL_FAILED` + `retryInStore: true`. Entitlement still revoked. |
| Play Store | Immediate revoke (`subscriptionsv2.revoke`) or period-end cancel | Attempted when optional Play credentials are present. Token is Superwall's `originalTransactionId`, which is an Apple-style subscription id analog — **not** reliably a Play purchase token. Google 4xx → `CANCEL_FAILED` + `retryInStore`. |
| Stripe | Immediate `DELETE /v1/subscriptions/{id}` | Attempted when optional `stripeSecretKey` is present and `originalTransactionId` is the Stripe subscription id. |

If cancel credentials are missing, or Play/Stripe HTTP fails, the handler still deletes AWS data + entitlement and returns `CANCEL_FAILED` with a CloudWatch **WARN** (`status`, `content-type`, truncated `bodySnippet` — no secrets / tokens / private keys).

Optional cancel fields live on the **existing** Superwall secret `wardrobe/{stage}/superwall` (no dedicated cancel secret):

```json
{
  "webhookSecret": "whsec_your_signing_secret",
  "productTiers": {},
  "stripeSecretKey": "sk_your_stripe_secret",
  "playPackageName": "your.android.package",
  "playServiceAccount": {
    "client_email": "play-developer@your-project.iam.gserviceaccount.com",
    "private_key": "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n",
    "private_key_id": "optional-key-id"
  }
}
```

`stripeSecretKey`, `playPackageName`, and `playServiceAccount` are optional. Omit them until operators have real Stripe / Play Developer credentials. CDK still creates only a placeholder secret — never commit live keys or product IDs. `MeFn` reads `SUPERWALL_SECRET_ARN` at runtime on `DELETE /me`.

### Entitlements (WARDROBE-91) — Flutter WARDROBE-90 contract

Client Superwall gates are not enough. This API is the source of truth for Free / Basic / Premium.

**Chosen path:** Superwall Svix webhook → verified Dynamo row `USER#{firebaseUid} / ENTITLEMENT`. Firebase custom claims are **not** written or read in this MVP (this stack does not use Firebase Admin). A later ticket may copy `tier` onto claims; do not treat ID-token claims as access.

Flutter must call Superwall `identify` with the **Firebase UID** so webhook `originalAppUserId` (or `userAttributes.firebaseUid`) maps to `USER#{uid}`.

#### Product matrix

| `tier` | Price (store) | Catalog | `features.aiTryOn` | `features.otherAi` |
| --- | --- | --- | --- | --- |
| `FREE` | £0 | max 1 wardrobe, 5 items, 5 outfits | false | false |
| `BASIC` | £5/mo or £50/yr | unlimited (`limits: null`) | false | false |
| `PREMIUM` | £15/mo or £150/yr | unlimited (`limits: null`) | true | true |

App Store / Play product IDs are **TBD**. Do not hardcode them in the app or this repo. Operators fill `productTiers` in Secrets Manager after the IDs exist.

#### `GET /me`

Call on launch and after Superwall restore / purchase. Identity from the Firebase authorizer.

```http
GET /me
Authorization: Bearer <firebase-id-token>
```

```json
{
  "userId": "firebase-uid",
  "tier": "FREE",
  "status": "NONE",
  "features": {
    "unlimitedCatalog": false,
    "aiTryOn": false,
    "otherAi": false
  },
  "limits": {
    "wardrobes": 1,
    "items": 5,
    "outfits": 5
  },
  "usage": {
    "wardrobes": 0,
    "items": 0,
    "outfits": 0
  },
  "updatedAt": "2026-09-16T12:00:00.000Z"
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `tier` | `FREE` \| `BASIC` \| `PREMIUM` | Missing row, unknown product, or past `expiresAt` → `FREE` |
| `status` | `NONE` \| `ACTIVE` \| `CANCELED` \| `BILLING_ISSUE` \| `PAUSED` \| `EXPIRED` | `CANCELED` still has access until `expiresAt` |
| `features.unlimitedCatalog` | boolean | `true` on Basic and Premium |
| `features.aiTryOn` | boolean | Premium only — POST outfit `/render` |
| `features.otherAi` | boolean | Premium only — recommendations + item-processing enqueue / retry (classify / colour / bg-removal) |
| `limits` | object or `null` | Free caps. `null` = unlimited |
| `usage` | object | Current owned counts (all wardrobes) |
| `productId` / `store` / `period` / `expiresAt` | optional | Soft-omitted when unknown. `store` is `APP_STORE` \| `PLAY_STORE` \| `STRIPE` \| `UNKNOWN`. `period` is `MONTHLY` \| `YEARLY` \| `UNKNOWN` |

Never includes Dynamo `PK` / `SK` / `lastEventId`. Soft-gate UX from this DTO; still handle the error codes below because the server enforces.

Premium item create still enqueues `PROCESS_WARDROBE_ITEM` and returns `PENDING`. Free / Basic item create skips the AI pipeline, writes `processingStatus: READY`, and does not enqueue.

#### Error codes (map to Superwall)

Same `{ "error": { "code", "message" } }` envelope as the rest of the API. No internal leaks.

| HTTP | `code` | When | Flutter paywall |
| --- | --- | --- | --- |
| 403 | `ENTITLEMENT_WARDROBE_LIMIT` | Free already has 1 wardrobe | Basic (or Premium) |
| 403 | `ENTITLEMENT_ITEM_LIMIT` | Free already has 5 items | Basic (or Premium) |
| 403 | `ENTITLEMENT_OUTFIT_LIMIT` | Free already has 5 outfits | Basic (or Premium) |
| 403 | `ENTITLEMENT_AI_REQUIRED` | Free or Basic hit Try On, recommendations, or other AI | Premium |

Reads (list/get wardrobe, item, outfit, GET `/render` poll) are not gated. PATCH / DELETE are not gated. Creating a PERSONAL AI profile is not gated; **using** it for try-on is.

#### Webhook / restore path

```text
Flutter Superwall purchase or restore
        │  identify(firebaseUid)
        v
Superwall  →  POST /webhooks/superwall  (Svix-signed, no Firebase auth)
        │  verify svix-id / svix-timestamp / svix-signature
        │  map productId → BASIC | PREMIUM
        v
DynamoDB USER#{uid} / ENTITLEMENT
        │
        v
Flutter GET /me   ← refresh after restore / launch
```

Public webhook (configure this URL in the Superwall dashboard → Integrations → Webhooks):

```http
POST /webhooks/superwall
```

Same Svix scheme as Resend. Invalid signatures return `403 UNAUTHORIZED`. Unknown users return `200 { "status": "ignored", "reason": "unknown_user" }` so Superwall does not retry forever. Duplicate `data.id` returns `200 { "status": "duplicate" }`.

Granting events (`initial_purchase`, `renewal`, `uncancellation`, `product_change`, `non_renewing_purchase`) set `ACTIVE` and map the product. `expiration` sets `FREE`. `cancellation` / `billing_issue` / `subscription_paused` keep the current tier until `expiresAt`. `GET /me` re-evaluates expiry.

After deploy, replace the placeholder (never commit the signing secret or live product IDs):

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/superwall \
  --secret-string '{"webhookSecret":"whsec_your_signing_secret","productTiers":{}}'
```

When App Store / Play product IDs exist, add them to `productTiers`:

```json
{
  "webhookSecret": "whsec_your_signing_secret",
  "productTiers": {
    "<ios-or-android-basic-monthly-id>": "BASIC",
    "<ios-or-android-basic-yearly-id>": "BASIC",
    "<ios-or-android-premium-monthly-id>": "PREMIUM",
    "<ios-or-android-premium-yearly-id>": "PREMIUM"
  }
}
```

Until that map is filled, a product ID containing `premium` / `basic` (case-insensitive) is mapped that way; any other paid grant defaults to **BASIC** (unlimited catalog, no AI). Stack output: `SuperwallWebhookUrl`, `SuperwallSecretName`.

The same secret may also hold optional WARDROBE-103 cancel fields (`stripeSecretKey`, `playPackageName`, `playServiceAccount`) — see **Account delete + subscription cancel** above. The webhook Lambda ignores those fields.

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
POST   /wardrobes/{wardrobeId}/items/{itemId}/reprocess
POST   /wardrobes/{wardrobeId}/items/{itemId}/move
POST   /wardrobes/{wardrobeId}/items/{itemId}/copy
POST   /wardrobes/{wardrobeId}/items/{itemId}/share
```

List supports optional smart filters (WARDROBE-21 / WARDROBE-92):

```http
GET /wardrobes/{wardrobeId}/items?category=TOP
GET /wardrobes/{wardrobeId}/items?category=TOP&colour=BLACK
GET /wardrobes/{wardrobeId}/items?category=TOP&colour=BLACK&subcategory=TSHIRT
GET /wardrobes/{wardrobeId}/items?acquiredAfter=2024-01-01
GET /wardrobes/{wardrobeId}/items?acquiredAfter=2024-01-01&acquiredBefore=2025-12-31
GET /wardrobes/{wardrobeId}/items?category=TOP&acquiredAfter=2024-01-01
```

- `category` — controlled `TOP | BOTTOM | DRESS | OUTERWEAR | SHOES | ACCESSORY | BAG`
- `colour` — controlled WARDROBE-20 tokens (`BLACK`, `WHITE`, `GREY`, `RED`, `BLUE`, `GREEN`, `YELLOW`, `ORANGE`, `PINK`, `PURPLE`, `BROWN`, `BEIGE`, `NAVY`, `CREAM`, `GOLD`, `SILVER`, `BURGUNDY`, `KHAKI`, `TEAL`, `OLIVE`, `MULTICOLOUR`)
- `subcategory` — optional controlled WARDROBE-19 token (`TSHIRT`, `JEANS`, …)
- `acquiredAfter` — optional inclusive lower bound on `acquiredAt` (`YYYY-MM-DD`)
- `acquiredBefore` — optional inclusive upper bound on `acquiredAt` (`YYYY-MM-DD`)

Filters are AND across query params. Within each param, matching is inclusive OR against the user field and AI metadata: `category` matches user `category` or `ai.detectedCategory`; `colour` matches user `colours` or `ai.detectedColours`; `subcategory` matches user `subcategory` or `ai.detectedSubcategory`. Date bounds compare the stored `acquiredAt` calendar date only (not `createdAt`). Items with no `acquiredAt` are **excluded** when `acquiredAfter` and/or `acquiredBefore` is present. Unknown tokens or invalid dates return `400` `VALIDATION_ERROR`. List still returns Flutter `{ "items": [...] }` (no DynamoDB `LastEvaluatedKey`; an opaque `nextCursor` can be added later).

Create body (`name`, `category`, and `imageKey` required):

```json
{
  "name": "Black T-Shirt",
  "category": "TOP",
  "subcategory": "TSHIRT",
  "colours": ["BLACK"],
  "brand": "Nike",
  "acquiredAt": "2024-06-15",
  "imageKey": "users/{uid}/uploads/....jpg"
}
```

`category` must be one of `TOP`, `BOTTOM`, `DRESS`, `OUTERWEAR`, `SHOES`, `ACCESSORY`, `BAG`. `imageKey` must be under `users/{uid}/uploads/` or another path owned by the authenticated user. `acquiredAt` is optional — see **Acquired date** below.

Create writes the DynamoDB item first, then sends `PROCESS_WARDROBE_ITEM` to the processing queue (`{ jobType, userId, wardrobeId, itemId, originalImageKey }`). Identity in that message comes from the Firebase authorizer, never from a body `userId`. Create returns `201` with the Flutter `ClothingItem` DTO (`itemId`, `wardrobeId`, `name`, `category`, optional `subcategory` / `colours` / `brand` / `acquiredAt`, `image.originalKey`, short-lived `originalImageUrl`, `processingStatus: PENDING`, ISO 8601 timestamps). Empty `subcategory` is soft-omitted on create (`null` / `""` are not stored). If enqueue fails, the request fails with `500 INTERNAL_ERROR` and the item is rolled back so the client can retry. List and get use the same DTO (Flutter `ItemListResponse` is `{ "items": [...] }`), including `processingStatus` and optional `processingError` on `FAILED` (WARDROBE-59). Missing or other-user wardrobes return `404` `WARDROBE_NOT_FOUND`. Missing items return `404` `ITEM_NOT_FOUND`. Delete returns `204`. Same-user move / copy of a terminal item (`READY` / `FAILED`) is WARDROBE-118 — see **Move / copy across wardrobes** below.

PATCH may include `name`, `category`, `subcategory`, `colours`, `brand`, `acquiredAt`, and `imageKey`. Omitted fields are left unchanged. For `subcategory` (WARDROBE-87): `null`, `""`, or whitespace-only **clears** the stored DynamoDB attribute (`REMOVE`; the response omits `subcategory`). A non-empty string sets it (trimmed; not restricted to the list-filter enum). Clearing `subcategory` alone is a soft success. `acquiredAt` uses the same omit / clear pattern (WARDROBE-92).

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
  "acquiredAt": "2024-06-15",
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
| `image.processedKey` | After background removal writes `processed.png` (typically `READY`). Omitted when `BACKGROUND_REMOVAL_ENABLED` is off (WARDROBE-62 default) — Flutter still has `originalKey` / `originalImageUrl` |
| `processedImageUrl` | Whenever `processedKey` exists — same 900s presigned GET. Both URLs are returned when both keys exist so Flutter can prefer processed |
| `processingError` | `FAILED` only — short worker reason (`originalImageKey` mismatch, permanent Gemini / image error, or exhausted retries). Omitted on PENDING / PROCESSING / READY |

URLs are never written to Dynamo. A presign failure is logged and the URL is omitted; the rest of the item still returns `200` / `201`. Same TTL as `POST /uploads` (`expiresIn: 900`) and outfit `render.imageUrl`.

#### Acquired date (WARDROBE-92) — Flutter WARDROBE-93 contract

**Field name:** `acquiredAt` (string). Same camelCase in the JSON DTO and Dynamo. This is a **calendar date**, not a datetime — `createdAt` / `updatedAt` stay ISO 8601 timestamps.

Flutter WARDROBE-93 should send and read `acquiredAt`. Do not use `purchasedAt`, `acquiredDate`, or `createdAt` for the purchase date.

| JSON / Dynamo field | Type | Required | Notes |
| --- | --- | --- | --- |
| `acquiredAt` | string | no | ISO date `YYYY-MM-DD` only. Example: `2024-06-15`. Datetimes such as `2024-06-15T12:00:00.000Z` are `400 VALIDATION_ERROR`. |
| `acquiredAfter` | query string | no | Inclusive lower bound on stored `acquiredAt`. Same `YYYY-MM-DD` format. |
| `acquiredBefore` | query string | no | Inclusive upper bound on stored `acquiredAt`. Same `YYYY-MM-DD` format. |

Soft-omit / clear (must not break existing create / list / get):

- **Create (`POST /wardrobes/{wardrobeId}/items`)** — omit `acquiredAt`, or send `null` / `""` / whitespace, to skip it. The attribute is not stored. Invalid format or impossible calendar dates (`2024-02-31`) are `400 VALIDATION_ERROR`.
- **Update (`PATCH /wardrobes/{wardrobeId}/items/{itemId}`)** — omitted → no change. `null`, `""`, or whitespace-only **clears** the stored DynamoDB attribute (`REMOVE`; the response omits `acquiredAt`). A valid date sets it (trimmed). Clearing `acquiredAt` alone is a soft success.
- **Responses** — present only when a value is stored. Never `null`. Create, list, get, and PATCH all use this DTO.
- **List filters** — `acquiredAfter` and `acquiredBefore` AND with `category` / `colour` / `subcategory`. Both bounds are inclusive. Items with no `acquiredAt` are excluded when either bound is present (they cannot be proven to fall in range). Blank query values are omitted. Invalid dates are `400 VALIDATION_ERROR` before Dynamo is queried.

PATCH example:

```http
PATCH /wardrobes/{wardrobeId}/items/{itemId}
```

```json
{ "acquiredAt": "2023-11-01" }
```

Clear:

```json
{ "acquiredAt": null }
```

Hide items acquired before 2024:

```http
GET /wardrobes/{wardrobeId}/items?acquiredAfter=2024-01-01
```

#### Move / copy across wardrobes (WARDROBE-118) — Flutter WARDROBE-119 contract

Same user only. Identity comes from the Firebase authorizer (`getUserId`). Body / query / path `userId` is ignored. Source wardrobe, source item, and target wardrobe must all belong to that UID.

```http
POST /wardrobes/{wardrobeId}/items/{itemId}/move
POST /wardrobes/{wardrobeId}/items/{itemId}/copy
```

```json
{ "targetWardrobeId": "wd_other12ab" }
```

`targetWardrobeId` is required, trimmed, 1–100 characters, and must be a **different** owned wardrobe than the path `{wardrobeId}`.

| Action | Dynamo | `itemId` | Images / metadata | Entitlement |
| --- | --- | --- | --- | --- |
| **Move** | Transactional put under `WARDROBE#{target}` + delete from `WARDROBE#{source}` (PK is wardrobe-scoped; this is not an in-place `wardrobeId` patch) | **Same** | Same `originalKey` / `processedKey` / `ai` / `processingStatus` / `processingError` / user fields. `createdAt` kept; `updatedAt` refreshed | Not a new item — Free 5-item cap is unchanged |
| **Copy** | `PutItem` under the target wardrobe | **New** `item_{nanoid}` | Metadata + `ai` copied. S3 objects are **shared** (same keys) — see below. New `createdAt` / `updatedAt` | Counts as a create — Free already at 5 items → `403 ENTITLEMENT_ITEM_LIMIT` |

Neither action enqueues `PROCESS_WARDROBE_ITEM`. The copy is already classified if the source was.

**S3 key layout (why share, not copy):**

```text
users/{uid}/uploads/{id}.jpg          original (create / PATCH imageKey)
users/{uid}/items/{itemId}/processed.png   background-removed cutout
```

Keys are **user-scoped**, not wardrobe-scoped. Item `DELETE` does not remove S3 objects. `ItemsFn` may only `GetObject` (presign `originalImageUrl` / `processedImageUrl`) — it has no `CopyObject` / `PutObject`. Sharing keeps ownership under `users/{uid}/` and avoids a second object. Flutter should treat `image.*` keys as opaque. After a copy, deleting the source item does **not** break the copy's URLs (objects stay until account wipe).

**Status gate:** `PENDING` / `PROCESSING` cannot be moved or copied (`400 VALIDATION_ERROR`). The processing worker reloads by the SQS `wardrobeId` + `itemId`; moving an in-flight item would orphan that job. Poll create / list / get until `READY` or `FAILED`, then transfer.

**Outfits:** Move is rejected if any outfit in the **source** wardrobe still references the item (`400 VALIDATION_ERROR`, message includes that `outfitId`). Flutter should remove the item from those outfits (or delete the outfits) first. Copy does not touch outfits.

Move returns `200` with the existing Flutter `ClothingItem` DTO (`wardrobeId` is the target). Copy returns `201` with a new `itemId` and target `wardrobeId`. Same soft-omit / presigned GET rules as list / get (`originalImageUrl` / `processedImageUrl`, no Dynamo `PK` / `SK` / `userId`).

```json
{
  "itemId": "item_xyz123abcd",
  "wardrobeId": "wd_other12ab",
  "name": "Black T-Shirt",
  "category": "TOP",
  "subcategory": "TSHIRT",
  "colours": ["BLACK"],
  "brand": "Nike",
  "acquiredAt": "2024-06-15",
  "image": {
    "originalKey": "users/{uid}/uploads/....jpg",
    "processedKey": "users/{uid}/items/{itemId}/processed.png"
  },
  "originalImageUrl": "https://...presigned GetObject...",
  "processedImageUrl": "https://...presigned GetObject...",
  "processingStatus": "READY",
  "createdAt": "2026-09-03T18:45:00.000Z",
  "updatedAt": "2026-09-19T00:00:00.000Z"
}
```

| Case | HTTP | `code` |
| --- | --- | --- |
| Missing token | 401 | `UNAUTHENTICATED` |
| Missing / blank / same-wardrobe `targetWardrobeId`; in-flight `PENDING` / `PROCESSING`; move while the item is on a source outfit | 400 | `VALIDATION_ERROR` |
| Missing / other-user **source** wardrobe | 404 | `WARDROBE_NOT_FOUND` |
| Missing / other-user item in the source wardrobe | 404 | `ITEM_NOT_FOUND` |
| Missing / other-user **target** wardrobe | 404 | `WARDROBE_NOT_FOUND` |
| Copy on Free at the 5-item cap | 403 | `ENTITLEMENT_ITEM_LIMIT` |
| Dynamo transaction / unexpected failure | 500 | `INTERNAL_ERROR` |

Flutter WARDROBE-119 should:

1. List the caller's wardrobes (`GET /wardrobes`) and hide the current one as the destination.
2. Poll until `processingStatus` is `READY` or `FAILED` before offering move / copy.
3. On move, if `400` mentions an outfit, prompt to remove the item from that outfit and retry.
4. After success, drop the item from the source list (move) or keep it and show the new `itemId` in the target (copy). Refresh `GET /me` usage after copy.
5. Call subsequent get / shopping-links / outfits / reprocess with the **target** `wardrobeId` (and the new `itemId` after copy).
6. A `FAILED` item can be retried after transfer via `POST .../items/{itemId}/reprocess` (WARDROBE-123) using that current wardrobeId. In-flight `PENDING` / `PROCESSING` items cannot be moved or copied — poll first.

### Processing worker

The processing Lambda consumes `wardrobe-item-processing`. DynamoDB is the source of truth: the worker reloads the clothing item and checks `userId`, `wardrobeId`, `itemId`, and `originalImageKey` before doing work. It does not trust the SQS body alone.

Status machine:

```text
PENDING → PROCESSING → READY     pipeline success
        → FAILED                 permanent / validation errors
                                 exhausted retries (last receive or DLQ)
```

The terminal failure string is **`FAILED`** (not `ERROR`). Flutter should stop polling when create / list / get return `FAILED` and may show optional `processingError`.

Poison messages (invalid JSON, unknown `jobType`, missing item, owner mismatch) are acked and dropped. An `originalImageKey` mismatch sets `FAILED` then acks.

Retries use the existing queue (WARDROBE-15): Lambda timeout **60s**, visibility timeout **120s** (visibility must stay greater than the timeout; AWS EventSourceMappings require this), `maxReceiveCount: 3`, then the DLQ + CloudWatch alarms. The processing DLQ uses the same **120s** visibility because `ProcessingFn` consumes it (WARDROBE-61). Retryable DynamoDB / provider / S3 errors are returned as SQS batch item failures so the message is redelivered. On the last receive (`ApproximateReceiveCount >= 3`) the worker writes `processingStatus: FAILED` plus `processingError` and acks. The same Lambda also consumes the processing DLQ so timeouts / crashes that never reached that last-receive write still become `FAILED` (WARDROBE-59). Dynamo is never left on `PROCESSING` as a terminal state.

Background removal (WARDROBE-26, gated by WARDROBE-62) reads the Dynamo-validated `originalImageKey` from the private media bucket, calls an injectable Gemini vision/image client (Secrets Manager credential; unit tests mock Gemini — no live Gemini calls in CI), writes `users/{userId}/items/{itemId}/processed.png`, and updates DynamoDB:

- `processedKey` — Flutter `ClothingItem.image.processedKey`
- `ai.backgroundRemoved = true`
- `ai.processedImageKey` — architecture metadata (merged into any existing `ai` map)

The original object is kept. **`BACKGROUND_REMOVAL_ENABLED` defaults to `false`** on `ProcessingFn`. When off, this step is skipped (Gemini is not called), the item is not failed for a missing Gemini image, and classify / colour use the original key. Permanent Gemini / missing-image failures throw `PermanentProcessingError` so the worker sets `FAILED` with `processingError` **only when the flag is on**. Transient failures throw `RetryableProcessingError` for SQS retry; after `maxReceiveCount` the worker (or DLQ path) sets `FAILED`.

To re-enable later: synth/deploy with `BACKGROUND_REMOVAL_ENABLED=true` or CDK context `backgroundRemovalEnabled=true`, or set that env var on `ProcessingFn` in the Lambda console (console-only edits are overwritten by the next CDK deploy).

Pipeline hooks:

1. Background removal (WARDROBE-26, Gemini) — implemented; **off by default** via `BACKGROUND_REMOVAL_ENABLED` (WARDROBE-62)
2. AI classification (WARDROBE-19/27, Gemini) — injectable `generateContent` classifier; persists `ai.detectedCategory` / `ai.detectedSubcategory` only (never overwrites user `category` / `subcategory`)
3. Colour / category detection (WARDROBE-20 / WARDROBE-29) — injectable Gemini `generateContent` detector (deployed default). Persists `ai.detectedColours` (controlled tokens such as `BLACK`, `WHITE`, `RED`, `BLUE`) and may refine `ai.detectedCategory` / `ai.detectedSubcategory`. Never overwrites user-owned `category`, `subcategory`, or `colours`. Soft Gemini failures throw `PermanentProcessingError` / `RetryableProcessingError` so the worker sets `FAILED` or retries then marks `FAILED` after exhaustion — they never 500 the worker.

Classification and colour detection both use the processed image key when present (including the key just written by Gemini), otherwise the original. Credentials come from Secrets Manager (`wardrobe/{stage}/gemini-background-removal`, `wardrobe/{stage}/gemini-classifier`, and `wardrobe/{stage}/gemini-colour`); unit tests inject mock clients or use `COLOUR_DETECTOR_STRATEGY=http` and never call a live vision API. After deploy, replace the Gemini placeholders with API keys (or JSON `{"apiKey":"...","model":"..."}`) — do not commit AI keys.

Gemini classifier and colour-detector failures follow the existing worker degrade path: permanent errors (`PermanentProcessingError`) mark the item `FAILED` and ack; transient errors (`RetryableProcessingError`) are reported as SQS batch item failures for retry, then `FAILED` after exhaustion (last receive or DLQ). The worker does not 500. A classifier HTTP 404 is permanent (WARDROBE-64) so the item is not left on `PROCESSING`.

CloudWatch (`ProcessingFn`): grep JSON fields `stage` (`bg-removal` / `classify` / `colour`), `pipelineEvent` (`start` / `success` / `fail` / `skip`), `geminiHttpStatus`, `geminiModel`, `geminiRequestPath`. Example: `{ $.stage = "classify" && $.geminiHttpStatus = 404 }`. Logs never include API keys or image bytes.

The worker still sets `processingStatus: READY` after the full pipeline returns successfully (and removes `processingError`), or `FAILED` on `PermanentProcessingError` / exhausted retries.

#### Flutter contract (WARDROBE-59)

Poll create / list / get until a terminal status. Do not treat `PROCESSING` as finished.

| `processingStatus` | Flutter |
| --- | --- |
| `PENDING` | Show processing; keep polling |
| `PROCESSING` | Show processing; keep polling |
| `READY` | Done; hide spinner |
| `FAILED` | Done; stop polling; show `processingError` when present |

`FAILED` is the only terminal failure value. There is no `ERROR` status.

#### Item processing retry (WARDROBE-123) — Flutter WARDROBE-124

One-tap retry for a **FAILED** clothing-item AI job. Reuses the same `enqueueProcessWardrobeItem` path as create (`PROCESS_WARDROBE_ITEM` `{ jobType, userId, wardrobeId, itemId, originalImageKey }`). Identity comes from the Firebase authorizer, never from a body `userId`.

```http
POST /wardrobes/{wardrobeId}/items/{itemId}/reprocess
Authorization: Bearer <firebase-id-token>
```

Body is optional. Empty, omitted, or `{}` are all accepted. Client-supplied `userId` / `processingStatus` are ignored.

**Success (`202`)** — Flutter `ClothingItem` DTO (same shape as get / create). `processingStatus` is `PENDING`. `processingError` is omitted.

```json
{
  "itemId": "item_xyz123abcd",
  "wardrobeId": "wd_abc123xyz0",
  "name": "Black T-Shirt",
  "category": "TOP",
  "image": {
    "originalKey": "users/{uid}/uploads/....jpg"
  },
  "originalImageUrl": "https://...presigned GetObject...",
  "processingStatus": "PENDING",
  "createdAt": "2026-09-03T18:45:00.000Z",
  "updatedAt": "2026-09-19T00:00:00.000Z"
}
```

Server steps on `FAILED`:

1. Owner check (`getOwnedItem`) — other-user / missing wardrobe is `404 WARDROBE_NOT_FOUND`; missing item is `404 ITEM_NOT_FOUND`
2. Premium check (`assertPremiumAi` / `features.otherAi`) — Free / Basic is `403 ENTITLEMENT_AI_REQUIRED`
3. Conditional Dynamo write `FAILED` → `PENDING` and `REMOVE processingError`
4. Enqueue `PROCESS_WARDROBE_ITEM` (same helper as create). If SendMessage fails, status is restored to `FAILED` (and the previous `processingError` when present) so Flutter can tap retry again (`500 INTERNAL_ERROR`)

The worker already accepts `PENDING` and skips `READY`. No new stuck-PENDING timeout is defined — Dynamo is never left on `PROCESSING` as a terminal state (WARDROBE-59 / DLQ). This endpoint does **not** re-enqueue `PENDING` or `PROCESSING`.

| Current `processingStatus` | Result |
| --- | --- |
| `FAILED` | `202` — reset to `PENDING`, enqueue |
| `FAILED` (concurrent second tap after the winner already reset) | `202` — return current `PENDING` item; **do not** enqueue again |
| `PENDING` | `409 PROCESSING_IN_PROGRESS` — already queued |
| `PROCESSING` | `409 PROCESSING_IN_PROGRESS` — already running |
| `READY` | `409 ITEM_NOT_RETRIABLE` — already succeeded |
| Missing `originalKey` | `400 VALIDATION_ERROR` |

| HTTP | `error.code` | When |
| --- | --- | --- |
| 202 | — | Retry accepted; poll get / list until `READY` / `FAILED` |
| 400 | `VALIDATION_ERROR` | Missing `wardrobeId` / `itemId`, no original image, or unsupported method |
| 401 | `UNAUTHENTICATED` | Missing / invalid Firebase ID token |
| 403 | `ENTITLEMENT_AI_REQUIRED` | Caller is not Premium |
| 404 | `WARDROBE_NOT_FOUND` | Wardrobe missing or not owned |
| 404 | `ITEM_NOT_FOUND` | Item missing or not owned |
| 409 | `PROCESSING_IN_PROGRESS` | Status is `PENDING` or `PROCESSING` |
| 409 | `ITEM_NOT_RETRIABLE` | Status is `READY` (or any non-FAILED, non-in-flight value) |
| 500 | `INTERNAL_ERROR` | Enqueue / Dynamo failure after the reset (status restored to `FAILED` when possible) |

Flutter WARDROBE-124 should show the retry CTA on `FAILED` only, call this endpoint, then wait for `GET /me/events` (WARDROBE-114) or poll create / list / get until a terminal status. Treat `409 PROCESSING_IN_PROGRESS` as “already running” (keep polling). Do not invent a client-side stuck-PENDING timeout unless a later backend ticket defines one.

Flutter WARDROBE-115 should prefer **AI job-done events** (`GET /me/events`) instead of blind-polling these item endpoints. Polling remains valid as a fallback.

### AI job-done events (WARDROBE-114) — Flutter WARDROBE-115 contract

When an async AI job reaches a **terminal** status (`READY` or `FAILED`), the worker writes a durable inbox row the app can list and ack. Optional FCM push uses the same deep-link payload when a device token is registered and `wardrobe/{stage}/firebase-fcm` is a real service-account JSON.

This is **not** a new AI feature. Only the existing SQS jobs emit events:

| `jobType` | Worker | Deep-link fields | Terminal `status` |
| --- | --- | --- | --- |
| `PROCESS_WARDROBE_ITEM` | `ProcessingFn` | `wardrobeId`, `itemId` | `READY` / `FAILED` |
| `RENDER_OUTFIT` | `OutfitRenderFn` | `wardrobeId`, `outfitId`, `renderId?`, `aiProfileId` | `READY` / `FAILED` |

`PROCESS_AI_PROFILE` is not enqueued today and does **not** emit events. Free / Basic item create writes `READY` in-request (no SQS) and does **not** write an inbox event.

Identity comes from the Firebase authorizer (`getUserId`). Body or query `userId` is ignored. These routes are **not** entitlement-gated (same as GET item / GET render).

```http
GET    /me/events
POST   /me/events/{eventId}/ack
POST   /me/events/ack
PUT    /me/devices
DELETE /me/devices/{deviceId}
```

#### `GET /me/events`

Query:

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `unreadOnly` | boolean string | No | `true` | `true` / `1` or `false` / `0`. Invalid values are `400 VALIDATION_ERROR`. |
| `limit` | integer string | No | `20` | `1`–`50`. Newest first. |

```json
{
  "events": [
    {
      "eventId": "evt_item_item_xyz123abcd_READY",
      "jobType": "PROCESS_WARDROBE_ITEM",
      "status": "READY",
      "wardrobeId": "wd_abc123xyz0",
      "itemId": "item_xyz123abcd",
      "createdAt": "2026-09-19T10:00:00.000Z"
    },
    {
      "eventId": "evt_render_rend_abc123xyz0_FAILED",
      "jobType": "RENDER_OUTFIT",
      "status": "FAILED",
      "wardrobeId": "wd_abc123xyz0",
      "outfitId": "outfit_qwerty12",
      "renderId": "rend_abc123xyz0",
      "aiProfileId": "profile_generic_01",
      "error": "Gemini blocked the try-on request (SAFETY)",
      "createdAt": "2026-09-19T09:55:00.000Z"
    }
  ],
  "unreadCount": 2
}
```

`JobEvent` fields (Flutter DTO — never `PK` / `SK` / FCM tokens):

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `eventId` | string | Yes | Deterministic. Item: `evt_item_{itemId}_{READY\|FAILED}`. Try-on: `evt_render_{renderId}_{READY\|FAILED}` (legacy jobs without `renderId` use `evt_render_{outfitId}_{aiProfileId}_{status}`). |
| `jobType` | `PROCESS_WARDROBE_ITEM` \| `RENDER_OUTFIT` | Yes | Same values as SQS `jobType`. |
| `status` | `READY` \| `FAILED` | Yes | Terminal only. Never `PENDING` / `PROCESSING`. |
| `wardrobeId` | string | Yes | Always present for deep-link. |
| `itemId` | string | Item jobs | Soft-omitted on try-on events. |
| `outfitId` | string | Try-on jobs | Soft-omitted on item events. |
| `renderId` | string | Try-on when known | Soft-omitted on legacy jobs and item events. |
| `aiProfileId` | string | Try-on | Soft-omitted on item events. |
| `error` | string | `FAILED` when the worker had a reason | Soft-omitted on `READY`. Same short reason as `processingError` / `render.error`. |
| `createdAt` | ISO 8601 | Yes | When the inbox row was first written. |
| `acknowledgedAt` | ISO 8601 | After ack | Soft-omitted while unread. |

`unreadCount` is the total unread rows (not capped by `limit`). Soft-omit optional JSON fields — never send `null`.

#### Ack

```http
POST /me/events/{eventId}/ack
```

`200` returns the acked `JobEvent` (includes `acknowledgedAt`). Already-acked events return `200` with the existing row (idempotent). Unknown / other-user ids return `404` `EVENT_NOT_FOUND`.

```http
POST /me/events/ack
```

```json
{ "eventIds": ["evt_item_item_xyz123abcd_READY", "evt_render_rend_abc123xyz0_FAILED"] }
```

`200` `{ "events": [ JobEvent, ... ] }`. Unknown ids are skipped (so a retry after TTL expiry is still `200`). Empty `eventIds` is `400 VALIDATION_ERROR`. Max `50` ids.

#### FCM device registration (optional)

Push is optional. Flutter WARDROBE-115 can soft-stub inbox-only and add tokens later.

```http
PUT /me/devices
```

```json
{
  "token": "<fcm-registration-token>",
  "platform": "IOS",
  "deviceId": "iphone-1"
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `token` | string | Yes | FCM registration token. Write-only; never returned. Max 4096 chars. |
| `platform` | `IOS` \| `ANDROID` | Yes | Other values are `400 VALIDATION_ERROR`. |
| `deviceId` | string | No | Letters, numbers, `_`, `-`, max 64. If omitted, backend stores `dev_{sha256(token)[:16]}`. |

`200` `{ "deviceId", "platform", "updatedAt" }`. Same `deviceId` upserts the token (idempotent).

```http
DELETE /me/devices/{deviceId}
```

`204` even when the device is already gone.

#### Push payload (when FCM is configured)

Data keys are **strings** (FCM requirement). Same deep-link fields as `JobEvent`:

```json
{
  "eventId": "evt_item_item_xyz123abcd_READY",
  "jobType": "PROCESS_WARDROBE_ITEM",
  "status": "READY",
  "wardrobeId": "wd_abc123xyz0",
  "itemId": "item_xyz123abcd"
}
```

Notification copy (also sent):

| `jobType` | `status` | title | body |
| --- | --- | --- | --- |
| `PROCESS_WARDROBE_ITEM` | `READY` | Item ready | Your clothing item has finished processing. |
| `PROCESS_WARDROBE_ITEM` | `FAILED` | Item processing failed | We could not finish processing this item. |
| `RENDER_OUTFIT` | `READY` | Try-on ready | Your outfit try-on is ready to view. |
| `RENDER_OUTFIT` | `FAILED` | Try-on failed | We could not finish this try-on. |

Missing tokens, missing / placeholder `firebase-fcm`, Google OAuth failures, and `UNREGISTERED` tokens are **soft-fail**: the inbox row still exists, the worker does not 5xx, and stale tokens are deleted. Flutter must not require push to mark a job done.

#### Writes / idempotency / TTL

Workers call `recordJobDone` after they persist `READY` or `FAILED` (and again on the “already READY” skip path). Dynamo `Put` uses `attribute_not_exists(PK)` on `USER#{uid}` / `EVENT#{eventId}`. Retries and DLQ replays do not duplicate inbox rows or re-send FCM.

Inbox rows set `ttl` (unix seconds, 30 days). The table already has TTL on `ttl`.

#### Error codes

| HTTP | `error.code` | When |
| --- | --- | --- |
| 401 | `UNAUTHENTICATED` | Missing / invalid Firebase ID token (authorizer). |
| 400 | `VALIDATION_ERROR` | Bad query, empty `eventIds`, unknown `platform`, invalid `deviceId` / `limit`. |
| 404 | `EVENT_NOT_FOUND` | Single ack of an unknown or other-user `eventId`. |
| 500 | `INTERNAL_ERROR` | Unexpected handler failure. Workers never return this for missing FCM tokens. |

#### Flutter inbox guidance (WARDROBE-115)

1. After `POST` item (Premium) or `POST .../render`, keep a local PENDING row if you want an immediate tray.
2. `GET /me/events?unreadOnly=true` (or handle FCM data) instead of tight-loop polling GET item / GET render.
3. Deep-link: item → `GET /wardrobes/{wardrobeId}/items/{itemId}`; try-on → `GET /wardrobes/{wardrobeId}/outfits/{outfitId}/render` (or the outfit).
4. `POST .../ack` when the user opens or dismisses the row.
5. Polling GET item / GET render remains the fallback if the inbox is empty (event write is best-effort relative to the status field).
6. After `POST .../items/{itemId}/reprocess` (WARDROBE-123), wait for the next terminal event. `READY` is a new `eventId`. A second `FAILED` reuses `evt_item_{itemId}_FAILED` (idempotent — if that row was already acked, poll GET item).

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
POST   /wardrobes/{wardrobeId}/outfits/{outfitId}/worn-on
GET    /wardrobes/{wardrobeId}/outfits/{outfitId}/worn-on
DELETE /wardrobes/{wardrobeId}/outfits/{outfitId}/worn-on/{date}
GET    /wardrobes/{wardrobeId}/worn-on
POST   /wardrobes/{wardrobeId}/outfits/{outfitId}/share
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

Create returns `201` with the Flutter `Outfit` DTO (`outfitId`, `wardrobeId`, `name`, `items[{itemId, slot}]`, optional `render` / `renderHistory` / `renderImageUrls`, ISO 8601 `createdAt` / `updatedAt`). List returns `{ "outfits": [...] }`. Missing or other-user wardrobes return `404` `WARDROBE_NOT_FOUND`. Missing outfits return `404` `OUTFIT_NOT_FOUND`. Referenced items that are not in the wardrobe return `404` `ITEM_NOT_FOUND`. Delete returns `204` and also deletes that outfit’s worn-on dates. Create / PATCH never accept a client-supplied `render` or `renderHistory` object.

### Share links (WARDROBE-126) — Flutter WARDROBE-128 / Frontend WARDROBE-127 contract

Share a **single clothing item** or **outfit** as a link + public preview. Not whole-wardrobe shares. No comments or social feed. **Growth feature** — available on Free / Basic / Premium; not entitlement-gated.

Identity on create / revoke comes from the Firebase authorizer (`getUserId`). Body / query / path `userId` is ignored. Public preview is a **separate API Gateway route with no Firebase authorizer** — the token is the capability.

```http
POST   /wardrobes/{wardrobeId}/items/{itemId}/share
POST   /wardrobes/{wardrobeId}/outfits/{outfitId}/share
DELETE /shares/{token}
GET    /public/shares/{token}
```

**`sharePath` is a relative path only.** This backend never invents or hardcodes an absolute public URL (no landing-site origin, CDN host, or deep-link scheme).

Flutter WARDROBE-128 and Frontend WARDROBE-127 compose the link the user opens:

```text
absoluteShareUrl = {landing-site base from client env} + sharePath
```

Example: landing-site base `https://share.example` + `sharePath` `/share/shr_V1StGXR8_Z5jdHi6B-myT` → `https://share.example/share/shr_V1StGXR8_Z5jdHi6B-myT`. Do not send `https://…` in `sharePath`. Do not ask this API for a public origin.

#### Create (owner only)

No request body. Returns `201` `Share`:

```json
{
  "token": "shr_V1StGXR8_Z5jdHi6B-myT",
  "resourceType": "ITEM",
  "wardrobeId": "wd_abc123xyz0",
  "itemId": "item_xyz123abcd",
  "sharePath": "/share/shr_V1StGXR8_Z5jdHi6B-myT",
  "expiresAt": "2026-10-19T12:00:00.000Z",
  "createdAt": "2026-09-19T12:00:00.000Z"
}
```

Outfit create is the same shape with `"resourceType": "OUTFIT"` and `outfitId` instead of `itemId`. Soft-omit the unused id — never send JSON `null`.

`sharePath` on this DTO is always `/share/{token}` — relative, no scheme or host. Flutter WARDROBE-128 / Frontend WARDROBE-127 prepend their landing-site base from env.

**Token:** `shr_` + 21 URL-safe `nanoid` characters. Longer than wardrobe / item ids because the token is the only secret on the public GET.

**TTL:** 30 days. `expiresAt` is ISO 8601. Dynamo also sets `ttl` (unix seconds) to the same instant so expired rows are eventually removed.

**Many tokens per resource (simpler option):** each `POST` issues a **new** token. Previous tokens stay valid until they expire or the owner revokes them. There is no one-active-per-resource constraint.

**Revoke:** `DELETE /shares/{token}` returns `204`. Idempotent if the token is already missing, revoked, or expired. Another user’s token is `404` `SHARE_NOT_FOUND` (same owner-only pattern as other routes). Revoke writes `revokedAt` and keeps the row until the original TTL so public GET can return `410` `SHARE_GONE` instead of pretending the link never existed.

Missing / other-user wardrobe, item, or outfit on create is the same as other routes: `404` `WARDROBE_NOT_FOUND` / `ITEM_NOT_FOUND` / `OUTFIT_NOT_FOUND`. Unauthenticated create / revoke is `401` `UNAUTHENTICATED`.

#### Public preview (no auth)

```http
GET /public/shares/{token}
```

`200` `SharePreview`:

```json
{
  "resourceType": "ITEM",
  "title": "Black T-Shirt",
  "imageUrl": "https://...presigned GetObject...",
  "expiresAt": "2026-10-19T12:00:00.000Z"
}
```

| Field | Notes |
| --- | --- |
| `resourceType` | `ITEM` or `OUTFIT` |
| `title` | Item or outfit `name` |
| `imageUrl` | Short-lived S3 **presigned GET** (`createPresignedGetUrl`, 900s). Soft-omitted when there is no image or presign fails. Item: `processedKey` then `originalKey`. Outfit: READY `render.imageKey`, else the first garment item’s processed/original. Never a public bucket ACL. |
| `expiresAt` | Same ISO 8601 as create |

**Never exposed:** firebase uid, `userId`, wardrobe lists, other items, private profile fields, Dynamo `PK` / `SK` / `GSI1*`, S3 object keys.

| Condition | Status | Code |
| --- | --- | --- |
| Missing or invalid token | `404` | `SHARE_NOT_FOUND` |
| Expired or revoked | `410` | `SHARE_GONE` |
| Underlying item / outfit deleted (or no longer owned by the token’s user) | `410` | `SHARE_GONE` |

**TTL drift:** while the share row still exists past `expiresAt`, GET is `410` `SHARE_GONE`. After Dynamo TTL deletes the row, GET is `404` `SHARE_NOT_FOUND`. Clients should treat both as “link no longer works.”

Account wipe (`DELETE /me` / `DELETE /me/content`) deletes the caller’s share rows (GSI1 `SHARE#USER#{uid}`). `UserWipeResult` does **not** add a `deletedShares` count — Flutter WARDROBE-102 stays unchanged.

Deleting an item or outfit does **not** eagerly delete its share rows. Public GET then returns `410` `SHARE_GONE`.

### Outfit worn-on log (WARDROBE-120) — Flutter WARDROBE-121 contract

Persist date-only “I wore this outfit on …” entries for a calendar / habit loop. **No AI.** Identity comes from the Firebase authorizer (`getUserId`). Body / query / path `userId` is ignored. The wardrobe and outfit must belong to that user. Not entitlement-gated (Free / Basic / Premium).

```http
POST   /wardrobes/{wardrobeId}/outfits/{outfitId}/worn-on
GET    /wardrobes/{wardrobeId}/outfits/{outfitId}/worn-on
DELETE /wardrobes/{wardrobeId}/outfits/{outfitId}/worn-on/{date}
GET    /wardrobes/{wardrobeId}/worn-on?from=YYYY-MM-DD&to=YYYY-MM-DD
```

**Field name:** `wornOn` (string). Same camelCase in the JSON DTO and Dynamo. This is a **calendar date** `YYYY-MM-DD`, not a datetime — `createdAt` stays an ISO 8601 timestamp (when the date was first logged).

Do not send `wornOnDate`, `wornAt`, or a datetime. Flutter WARDROBE-121 should use `wornOn`.

#### Set (mark worn)

```json
{ "wornOn": "2026-09-18" }
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `wornOn` | string | yes | ISO date `YYYY-MM-DD` only. Example: `2026-09-18`. Datetimes such as `2026-09-18T12:00:00.000Z` are `400 VALIDATION_ERROR`. Impossible calendars (`2026-02-31`) are `400`. |

- First log of that date → `201` with the `OutfitWornOn` entry.
- Same date again → `200` with the **existing** entry (`createdAt` unchanged). Idempotent for a calendar tap.
- Body `userId` is ignored.

```json
{
  "outfitId": "outfit_xyz123ab",
  "wardrobeId": "wd_abc123xyz0",
  "wornOn": "2026-09-18",
  "createdAt": "2026-09-18T19:10:00.000Z"
}
```

#### List (one outfit)

`GET .../outfits/{outfitId}/worn-on` returns `{ "entries": [...] }` newest date first. Empty log is `200` `{ "entries": [] }`.

#### Remove (optional unmark)

`DELETE .../worn-on/{date}` — `{date}` is `YYYY-MM-DD`. Returns `204`. Missing / already-removed dates are also `204` (idempotent). Invalid path dates are `400 VALIDATION_ERROR`. Outfit / wardrobe ownership failures stay `404` (see errors below).

#### Wardrobe calendar

`GET /wardrobes/{wardrobeId}/worn-on` returns every worn-on entry in that wardrobe (`{ "entries": [...] }`, newest `wornOn` first, then `outfitId`). Optional inclusive bounds:

| Query | Type | Required | Notes |
| --- | --- | --- | --- |
| `from` | string | no | Inclusive lower bound on `wornOn` (`YYYY-MM-DD`). |
| `to` | string | no | Inclusive upper bound on `wornOn` (`YYYY-MM-DD`). |

Blank query values are omitted. Invalid dates / datetimes are `400 VALIDATION_ERROR`. `from` after `to` is `400`. Entries outside the range are excluded. Flutter should join `outfitId` to a cached outfit list for names / thumbnails — this payload stays date-only.

#### Errors

| Case | Response |
| --- | --- |
| Missing token | `401 UNAUTHENTICATED` |
| Other-user / missing wardrobe | `404 WARDROBE_NOT_FOUND` |
| Other-user / missing outfit | `404 OUTFIT_NOT_FOUND` |
| Missing / invalid `wornOn` or `{date}` | `400 VALIDATION_ERROR` |
| `from` after `to` | `400 VALIDATION_ERROR` |

No `WORN_ON_NOT_FOUND`. Soft-omit unused optional fields; never send JSON `null`. Create / PATCH outfit never accept client-supplied worn-on arrays. GET outfit / list outfits are unchanged (no `wornOn` field) — Flutter reads the dedicated routes.

**Dynamo (single-table, same outfit keys):** `PK = WARDROBE#{wardrobeId}`, `SK = OUTFIT#{outfitId}#WORN#{YYYY-MM-DD}`, `entityType = WORN_ON`. One row per outfit+date. Deleting an outfit also deletes its worn-on rows. `DELETE /me` and `DELETE /me/content` wipe them with the wardrobe children. Entitlement outfit caps count `OUTFIT` rows only.

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

POST returns `202` with the Flutter `Outfit` DTO including `render` (and history when earlier try-ons exist). GET `/render` returns the Flutter `OutfitRender` record for the current request (poll). GET outfit and list include `render` plus append-only history (WARDROBE-85) — see **Outfit render history** below.

```json
{
  "status": "READY",
  "aiProfileId": "profile_generic_01",
  "imageKey": "users/uid/outfits/outfit_xyz123ab/renders/rend_new1abcd.png",
  "imageUrl": "https://...presigned GetObject..."
}
```

| Field | When present |
| --- | --- |
| `status` | Always: `PENDING` \| `PROCESSING` \| `READY` \| `FAILED` |
| `aiProfileId` | Profile used for this request |
| `imageKey` | `READY` — S3 object `users/{uid}/outfits/{outfitId}/renders/{renderId}.png` (legacy rows may still use `…/render.png`) |
| `imageUrl` | `READY` on list / GET outfit / GET `/render` — 15-minute presigned GET. Soft-omitted if that presign fails |
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

**Worker:** Dynamo is the source of truth. It reloads the outfit (owner check), the profile (`getReadableAiProfile` + `READY` + the frontal `front.*` reference image + optional WARDROBE-80 / WARDROBE-82 body/context fields), and each garment (prefer `originalKey`, else `processedKey` — cutouts overlay too easily). Gemini `generateContent` (image, `3:4`) writes a **new** `renders/{renderId}.png` and **appends** that key to `renderHistory` — it does not overwrite earlier successful try-ons. Present body fields are added to the prompt (`height: 175 cm`, `bra size: 34B`, …); missing fields are omitted and do not fail render. Permanent Gemini / missing-image / profile errors set `FAILED` with `render.error` and ack (history of earlier successes is kept). Transient errors are SQS batch failures (`maxReceiveCount: 3` then DLQ). Poison messages (invalid JSON, wrong `jobType`, missing fields) are acked.

### Outfit render history (WARDROBE-85) — Flutter WARDROBE-84 contract

Successful try-ons are **append-only**. A later POST `/render` updates the current `render` status (`PENDING` → worker → `READY` / `FAILED`) but does **not** replace earlier READY images in S3 or Dynamo.

**Shape:** existing `render` (current / latest try-on) **plus** a newest-first history array **plus** a newest-first URL list. Latest is clearly `render.imageUrl` when the current render is `READY` and that presign succeeds, and is also `renderImageUrls[0]` / `renderHistory[0]` when those fields are present.

Owner-only, same as today. Identity comes from the Firebase authorizer. List and get use this DTO. GET `/render` stays the single current `OutfitRender` poll record (WARDROBE-47) — it does not include history.

```json
{
  "outfitId": "outfit_xyz123ab",
  "wardrobeId": "wd_abc123xyz0",
  "name": "Friday Night",
  "items": [
    { "itemId": "item_...", "slot": "TOP" },
    { "itemId": "item_...", "slot": "BOTTOM" }
  ],
  "render": {
    "status": "READY",
    "aiProfileId": "profile_generic_01",
    "imageKey": "users/{uid}/outfits/outfit_xyz123ab/renders/rend_new1abcd.png",
    "imageUrl": "https://...presigned GetObject for latest..."
  },
  "renderHistory": [
    {
      "imageKey": "users/{uid}/outfits/outfit_xyz123ab/renders/rend_new1abcd.png",
      "imageUrl": "https://...presigned GetObject for latest...",
      "createdAt": "2026-09-11T08:00:00.000Z",
      "aiProfileId": "profile_generic_01"
    },
    {
      "imageKey": "users/{uid}/outfits/outfit_xyz123ab/render.png",
      "imageUrl": "https://...presigned GetObject for earlier...",
      "createdAt": "2026-09-10T08:00:00.000Z",
      "aiProfileId": "profile_generic_01"
    }
  ],
  "renderImageUrls": [
    "https://...presigned GetObject for latest...",
    "https://...presigned GetObject for earlier..."
  ],
  "createdAt": "2026-09-03T19:10:00.000Z",
  "updatedAt": "2026-09-11T08:00:00.000Z"
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `render` | object | no | Current try-on. Same WARDROBE-47 fields: `status`, `aiProfileId`, optional `imageKey` / `imageUrl` / `error`. Flutter that only reads `render` keeps working. |
| `render.status` | string | when `render` present | `PENDING` \| `PROCESSING` \| `READY` \| `FAILED` |
| `render.aiProfileId` | string | when `render` present | Profile used for the current request |
| `render.imageKey` | string | `READY` only | Latest S3 key. Legacy single-file rows may still be `…/outfits/{outfitId}/render.png` |
| `render.imageUrl` | string | no | Latest presigned GET (900s). Present when current status is `READY` and that presign succeeds |
| `render.error` | string | `FAILED` only | Worker reason |
| `renderHistory` | array | no | Successful try-ons, **newest first**, including the latest. Soft-omitted when there are none. Never includes PENDING / FAILED |
| `renderHistory[].imageKey` | string | yes | Stored S3 key. Not an HTTPS URL |
| `renderHistory[].createdAt` | string | yes | ISO 8601 when that try-on became READY |
| `renderHistory[].aiProfileId` | string | yes | Profile used for that try-on |
| `renderHistory[].imageUrl` | string | no | Presigned GET for that key. Soft-omitted when that presign fails |
| `renderImageUrls` | string[] | no | Presigned GET URLs only, **newest first**. `[0]` is the latest URL that presigned successfully. Soft-omitted when empty |

Soft-omit rules (must not break list / get / create / PATCH / POST `/render`):

- **Presign failure** — omit that URL only (`render.imageUrl` and/or that `renderHistory[].imageUrl`, and drop it from `renderImageUrls`). Do **not** fail the whole response. List / get still return `200`.
- **All history presigns fail** — omit `renderImageUrls`. Keep `renderHistory` entries without `imageUrl`. Keep `render.status` / `imageKey`.
- **No successful try-ons yet** — omit `renderHistory` and `renderImageUrls`.
- **Current render is PENDING / PROCESSING / FAILED** — `render` has no `imageUrl`. Previous successes still appear in `renderHistory` / `renderImageUrls`.
- **Legacy outfit** with only `render.imageKey` and no stored `renderHistory` — list/get still return that image as a one-entry newest-first list (seeded from the current READY key).
- **URLs are never written to Dynamo.** Same helper / TTL as clothing-item `originalImageUrl` (`createPresignedGetUrl`, `expiresIn` **900**).
- **Create / PATCH** never accept client-supplied `render`, `renderHistory`, or `renderImageUrls`.
- **Auth** — owner-only, same as outfit CRUD. Other-user / missing wardrobe or outfit stays `404`.

Flutter WARDROBE-84 should:

1. Keep using `render.status` / `render.imageUrl` for the current try-on (poll GET `/render` or GET outfit until `READY` / `FAILED`).
2. Bind the gallery to `renderImageUrls` (newest first; index `0` is latest when present).
3. Use `renderHistory` when a timestamp or `aiProfileId` caption is needed. Skip entries with no `imageUrl`.
4. Treat a missing `renderImageUrls` as an empty gallery, not an error.

**Secret** `wardrobe/{stage}/gemini-try-on` (stack output `GeminiTryOnSecretName`):

- raw API key, or
- JSON `{ "apiKey", "model?", "endpoint?" }` (`api_key` / `key` also accepted)

Default model `gemini-3.1-flash-image`. Never commit AI keys.

#### After deploy — console / secret steps

1. Deploy the stack (`npm run deploy` or the pipeline). Note `ApiUrl`, `MediaBucketName`, `GeminiTryOnSecretName`, `OutfitRenderQueueUrl`.
2. Populate the try-on secret (same Gemini key as background-removal is fine):

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/gemini-try-on \
  --secret-string '{"apiKey":"your-gemini-api-key","model":"gemini-3.1-flash-image"}'
```

CDK creates the secret as a placeholder. IAM: `OutfitRenderFn` may `secretsmanager:GetSecretValue` on this secret only. `OutfitsFn` may `sqs:SendMessage` on the try-on queue. The worker may consume the queue, `GetItem` / `Query` / `UpdateItem` on the table, and S3 read + put (no delete). No extra IAM console steps if you deploy via CDK.
3. Upload GENERIC_MODEL full-body photos if you have not already (WARDROBE-45 / WARDROBE-72 keys under `shared/ai-profiles/generic/{slug}/front.png`). A missing model photo marks the render `FAILED` with `Image not found: shared/ai-profiles/generic/...`.
4. Confirm: `POST .../outfits/{outfitId}/render` with `{ "aiProfileId": "profile_generic_01" }`, then wait for `GET /me/events` (`jobType: RENDER_OUTFIT`) or poll `GET .../render` until `READY` or `FAILED`.
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

Defaults when omitted: model `gpt-4.1-mini`, endpoint `https://api.openai.com/v1/chat/completions`. Never commit AI keys.

**Soft-failure policy:** OpenAI HTTP errors, timeouts, parse failures, missing/placeholder credentials, or an unusable response do **not** 500 the app. The handler falls back to the rule-based recommender and still returns `200`. Empty / insufficient READY items skip the vendor and return `{ "recommendations": [] }`.

Unit tests inject `fetchSecret` / `httpPost` (or the rule-based strategy) — no live OpenAI calls in CI.

### Related shopping links (WARDROBE-96) — Flutter WARDROBE-95 contract

Not entitlement-gated. **Free, Basic, and Premium** may call these routes. The handler does **not** read `USER#{uid}/ENTITLEMENT` and never returns `ENTITLEMENT_*`.

Identity comes from the Firebase authorizer (`getUserId`). Body or query `userId` is ignored.

```http
GET /wardrobes/{wardrobeId}/items/{itemId}/shopping-links
GET /shopping-links?limit=5&linksPerItem=8
```

| Route | Behaviour |
| --- | --- |
| Item-scoped | Shopping links for one **owned** item |
| Home / mixed | Up to `limit` **recent** items across the caller’s wardrobes (newest `updatedAt` first). Each item returns up to `linksPerItem` cards |

Query params (Home). Blank values are omitted. Invalid values are `400 VALIDATION_ERROR` before Dynamo is queried.

| Query | Default | Min | Max |
| --- | --- | --- | --- |
| `limit` | 5 | 1 | 10 |
| `linksPerItem` | 8 | 1 | 12 |

Item-scoped also accepts `linksPerItem` (same bounds). `limit` is ignored there unless present and invalid (`400`).

#### Link object (soft-omit unset; never `null`)

`title` (string, required), `url` (string, required), optional `merchant`, `price` (string), `currency`, `imageUrl`.

`data:` image payloads from SERP are dropped. If Bright Data returns a product title but no product URL, `url` is a Google Shopping search for that title so Flutter always has a tappable link.

#### Item response

```json
{
  "itemId": "item_xyz123abcd",
  "wardrobeId": "wd_abc123xyz0",
  "keywords": ["black nike t-shirt", "mens black crew neck tee"],
  "cached": false,
  "links": [
    {
      "title": "Nike Sportswear Club Tee",
      "url": "https://www.example.com/product",
      "merchant": "Nike",
      "price": "£24.99",
      "currency": "GBP",
      "imageUrl": "https://..."
    }
  ]
}
```

Optional `warning` is present only when the response is degraded:

```json
{
  "warning": {
    "code": "SHOPPING_UPSTREAM_UNAVAILABLE",
    "message": "Shopping links are temporarily unavailable."
  }
}
```

#### Home response

```json
{
  "items": [
    {
      "itemId": "item_xyz123abcd",
      "wardrobeId": "wd_abc123xyz0",
      "keywords": ["black nike t-shirt"],
      "cached": true,
      "links": []
    }
  ]
}
```

Home returns a section only for items that were considered. If every considered item fails upstream with no cache, `items` is `[]`.

#### Errors / soft-fail

| Case | HTTP | `code` |
| --- | --- | --- |
| Missing token | 401 | `UNAUTHENTICATED` |
| Missing / other-user wardrobe | 404 | `WARDROBE_NOT_FOUND` |
| Missing / other-user item | 404 | `ITEM_NOT_FOUND` |
| Invalid `limit` / `linksPerItem` | 400 | `VALIDATION_ERROR` |
| OpenAI / Bright Data errors, timeouts, missing or placeholder secrets, parse failures | **200** | empty `links` (item-scoped) or omitted Home rows / `items: []`. Optional per-item `warning.code = SHOPPING_UPSTREAM_UNAVAILABLE` |

Never 5xx for upstream blips. Missing wardrobe/item stays 404 (not a soft-fail).

#### Pipeline (server-side only)

1. Load item metadata (name, category, subcategory, colours, brand, AI detections when present) and the item image from S3 (**processed key preferred**, else original).
2. Call **OpenAI** vision/chat (`gpt-4.1-mini` default) on the image + metadata → search keywords.
3. Call **Bright Data SERP API** (`POST https://api.brightdata.com/request`, `format: "json"`) with Google Shopping (`tbm=shop`, `brd_json=json`). Do not send `udm=28` — Bright Data’s shopping parser keys off `tbm=shop`, and `format: "raw"` returns HTML (WARDROBE-98).
4. Map SERP products onto the Link DTO.

Flutter never talks to OpenAI or Bright Data.

#### Secrets (NEW paths)

Never commit keys. CDK creates placeholders; replace them after deploy. Stack outputs: `OpenAiShoppingSecretName`, `BrightDataSecretName`.

**OpenAI shopping keywords** — `wardrobe/{stage}/openai-shopping`

Raw API key, or JSON `{ "apiKey", "model?", "endpoint?" }` (`api_key` / `key` / `openaiApiKey` also accepted). Defaults: model `gpt-4.1-mini`, endpoint `https://api.openai.com/v1/chat/completions`.

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/openai-shopping \
  --secret-string '{"apiKey":"sk-your-openai-key","model":"gpt-4.1-mini"}'
```

```bash
# raw key also works
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/openai-shopping \
  --secret-string "sk-your-openai-key"
```

The shopping-links Lambda reads `OPENAI_SHOPPING_SECRET_ARN` at runtime. Optional env / secret overrides: `OPENAI_SHOPPING_MODEL`, `OPENAI_SHOPPING_ENDPOINT`.

**Bright Data SERP** — `wardrobe/{stage}/bright-data`

JSON only (a raw string is rejected). The token must be a Bright Data **API key** (Bearer), and `zone` must be a **SERP API** zone — not Web Unlocker (`web_unlocker1`) and not a proxy zone. A Web Unlocker zone returns HTML even with a valid token.

| Field | Required | Notes |
| --- | --- | --- |
| `apiToken` | yes | Bearer API key from the SERP zone Overview (or Account settings). Aliases: `api_token`, `token`, `apiKey`, `api_key`, `key`, `BRIGHT_DATA_API_TOKEN` |
| `zone` | yes | SERP zone name (e.g. `serp_api1`). Alias: `zoneName`, `zone_name` |
| `endpoint` | no | Default `https://api.brightdata.com/request`. Do not point this at a proxy host |
| `customer` | no | Bright Data customer id (documented for operators; REST `/request` uses `apiToken` + `zone`) |
| `country` | no | ISO country for SERP targeting (`gl` on the Google URL and `country` on the POST body). Default `gb`. Aliases: `gl`, `geo` |
| `language` | no | Default `en`. Aliases: `hl`, `lang` |

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/bright-data \
  --secret-string '{"apiToken":"your-bright-data-api-token","zone":"serp_api1","country":"gb","language":"en"}'
```

Request sent to Bright Data (code, not the secret):

- `POST https://api.brightdata.com/request`
- `Authorization: Bearer <apiToken>`
- `Content-Type: application/json`
- `Accept: application/json`

```json
{
  "zone": "serp_api1",
  "url": "https://www.google.com/search?q=...&tbm=shop&hl=en&gl=gb&brd_json=json",
  "format": "json",
  "country": "gb"
}
```

`format` must be `"json"`. Bright Data’s SERP OpenAPI treats `"raw"` as an HTML string — that was the WARDROBE-98 CloudWatch `non-JSON body` failure. `brd_json=json` is the current parsed-JSON query value (`html` is the default). Do not add `udm=28` alongside `tbm=shop`.

On upstream failure CloudWatch logs `status`, `contentType`, and a truncated `bodySnippet` (secrets / `apiToken` / `Authorization` are never logged). Flutter still receives the WARDROBE-96 Link DTO: `200` with empty `links` (item-scoped) or omitted Home rows, plus optional `warning.code = SHOPPING_UPSTREAM_UNAVAILABLE`.

Do **not** put these keys in the Flutter app.

#### Cache (MVP)

DynamoDB single-table row, **TTL 24h**:

```text
PK  USER#{uid}
SK  SHOPPING#{itemId}
entityType  SHOPPING_CACHE
ttl         unix seconds (Dynamo TTL attribute)
```

**Cache key** = SHA-256 of `userId` + `itemId` + preferred image object key + a stable metadata fingerprint (name / category / subcategory / colours / brand). Keywords and the SERP query are stored on the row (so a cache hit skips OpenAI and Bright Data). Changing the image key or those metadata fields is a miss.

- Fresh match → `cached: true`, no vendor calls.
- **Stale-while-error:** if OpenAI or Bright Data fails and a prior cache row exists for that item — even if **expired** or the fingerprint no longer matches — that row is returned (`cached: true`) plus `warning: SHOPPING_UPSTREAM_UNAVAILABLE` instead of empty links.
- Cache write failures are logged and do not fail the request.

Account wipe (`DELETE /me` / `DELETE /me/content`) also deletes these `SHOPPING#` rows.

Unit tests inject `fetchSecret` / HTTP clients / cache / S3 image loader — no live OpenAI or Bright Data in CI.

## Auth

Identity always comes from the validated Firebase token (`sub` = Firebase UID). Clients must not send `userId` as proof of ownership.

Unauthenticated routes: `GET /health`, `GET /public/shares/{token}` (WARDROBE-126 — token is the capability), Superwall / support webhooks.

A Lambda authorizer reads the Firebase project ID from Secrets Manager and validates the ID token:

- Issuer: `https://securetoken.google.com/<firebase-project-id>`
- Audience: `<firebase-project-id>`

## AI profiles (WARDROBE-43 / WARDROBE-44 / WARDROBE-45 / WARDROBE-73 / WARDROBE-80 / WARDROBE-82)

Phase-3 foundation. Separate from wardrobe CRUD. Outfit try-on / render is WARDROBE-47.

Identity comes from the Firebase authorizer (`getUserId`). Body/query/path `userId` is ignored.

```http
POST   /ai-profiles
GET    /ai-profiles
GET    /ai-profiles?type=PERSONAL
GET    /ai-profiles?type=GENERIC_MODEL
GET    /ai-profiles/models
GET    /ai-profiles/{aiProfileId}
PATCH  /ai-profiles/{aiProfileId}
DELETE /ai-profiles/{aiProfileId}
POST   /ai-profiles/{aiProfileId}/uploads
POST   /ai-profiles/{aiProfileId}/reference-images
```

| Route | Behaviour |
| --- | --- |
| `POST /ai-profiles` | Create a `PERSONAL` profile for the token UID. Body is optional. Starts `READY` with `referenceImages: []` (nothing to process yet). |
| `GET /ai-profiles` | List the caller's `PERSONAL` profiles. `?type=GENERIC_MODEL` lists the shared model catalog (same as `/models`). Includes `frontImageUrl` when a frontal key can be presigned (WARDROBE-73). |
| `GET /ai-profiles/models` | Try-on picker: every seeded `GENERIC_MODEL` profile (WARDROBE-45). Same DTO, including `frontImageUrl`. |
| `GET /ai-profiles/{aiProfileId}` | Owner-only for `PERSONAL`. Any authenticated user may read `GENERIC_MODEL`. Other-user personal profiles return `404 AI_PROFILE_NOT_FOUND` (no leak). Same `frontImageUrl` contract as list. |
| `PATCH /ai-profiles/{aiProfileId}` | Owner `PERSONAL` only. Update optional body/context fields (WARDROBE-80 / WARDROBE-82). `GENERIC_MODEL` is `403`. |
| `DELETE /ai-profiles/{aiProfileId}` | Owner `PERSONAL` only (`204`). Users cannot delete `GENERIC_MODEL` (`403 UNAUTHORIZED`). |
| `POST /ai-profiles/{aiProfileId}/uploads` | Owner `PERSONAL` only. Returns a Flutter `UploadTicket` for a reference photo under `users/{uid}/ai-profiles/{aiProfileId}/`. |
| `POST /ai-profiles/{aiProfileId}/reference-images` | Owner `PERSONAL` only. Attach confirmed `objectKey`(s) into `referenceImages[]`. |

Create body (all fields optional):

```json
{
  "type": "PERSONAL",
  "referenceImages": [],
  "heightCm": 170,
  "weightKg": 65,
  "bustCm": 90,
  "hipsCm": 98,
  "clothingSize": "M",
  "braSize": "34B",
  "ageYears": 28,
  "bodyType": "AVERAGE",
  "gender": "FEMALE"
}
```

- `type` — omit or `PERSONAL`. `GENERIC_MODEL` is rejected (`400`); those rows are seeded (WARDROBE-45).
- `referenceImages` — omit or `[]` on create. If sent, each key must be under `users/{uid}/`. Prefer the presign + attach flow below.
- Body/context fields (WARDROBE-80 / WARDROBE-82) — all optional; omit, `null`, or `""` to skip. See the Flutter contract below.
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

Seeded generic models also include optional `label` (picker display name) plus seeded body/context defaults (WARDROBE-80). PERSONAL rows omit `label`. Empty body/context fields (including `braSize`) are **soft-omitted** from every response — they are never required and never sent as `null`.

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

### Body / context fields (WARDROBE-80) — Flutter WARDROBE-81 contract

Same camelCase names in the JSON DTO, Dynamo attributes, and the Gemini try-on prompt. **Units are encoded in the field names** (cm / kg / years). There is no separate unit-preference field — Flutter should send metric values only.

| JSON / Dynamo field | Type | Unit | Required | Notes |
| --- | --- | --- | --- | --- |
| `heightCm` | number (int or decimal) | centimetres | no | Range 50–250 |
| `weightKg` | number (int or decimal) | kilograms | no | Range 15–400 |
| `bustCm` | number (int or decimal) | centimetres | no | Range 40–200 |
| `hipsCm` | number (int or decimal) | centimetres | no | Range 40–200 |
| `clothingSize` | string | — | no | Free-form clothing size, max 32 chars. Examples: `XS`, `S`, `M`, `L`, `XL`, `UK 10`, `US 8` |
| `braSize` | string | — | no | Free-form bra / cup size, max 32 chars. Examples: `34B`, `32C`, `36DD`. Not canonicalized. Flutter WARDROBE-83 should send this name. |
| `ageYears` | integer | years | no | Range 1–120 |
| `bodyType` | string | — | no | Recommended: `SLIM`, `AVERAGE`, `ATHLETIC`, `CURVY`, `PLUS`, `PETITE`. Other non-empty strings are stored. Known tokens are canonicalized (`slim` → `SLIM`). |
| `gender` | string | — | no | Recommended: `FEMALE`, `MALE`, `NON_BINARY`, `UNSPECIFIED`. Other non-empty strings are stored. Known tokens are canonicalized (`non-binary` → `NON_BINARY`). |

Soft-omit rules (must not break create / get / list / try-on):

- **Create (`POST /ai-profiles`)** — omit a field, or send `null` / `""`, to skip it. Invalid types or out-of-range numbers are `400 VALIDATION_ERROR`.
- **Update (`PATCH /ai-profiles/{aiProfileId}`)** — owner `PERSONAL` only. Send at least one body/context field. `null` or `""` **clears** that stored field. Omitted fields are left unchanged.
- **Responses** — a field is present only when a value is stored. Never `null`. List, get, create, update, attach, and `/models` all use this DTO.
- **Try-on** — stored fields are copied into the Gemini prompt as `height: 175 cm`, `weight: 70 kg`, … Missing fields are not mentioned. Empty context does not fail render.
- **Images** — `frontImageUrl` / `referenceImages` / `referenceImageUrls` are unchanged (WARDROBE-73 / WARDROBE-79).

PATCH example:

```http
PATCH /ai-profiles/{aiProfileId}
```

```json
{
  "heightCm": 172.5,
  "weightKg": 64,
  "clothingSize": "M",
  "bustCm": null
}
```

`bustCm: null` removes a previously stored bust. GENERIC_MODEL rows cannot be patched (`403`).

### Bra size (WARDROBE-82) — Flutter WARDROBE-83 contract

**Field name:** `braSize` (string). Same camelCase in the JSON DTO, Dynamo, and the Gemini try-on prompt. No stronger existing convention was found (`cupSize` / `bra_size` are not used). Flutter WARDROBE-83 should adopt `braSize`.

| JSON / Dynamo field | Type | Required | Notes |
| --- | --- | --- | --- |
| `braSize` | string | no | Free-form, max 32 chars. Examples: `34B`, `32C`, `36DD`. Stored as sent (trimmed). Not canonicalized. |

Same soft-omit rules as the WARDROBE-80 body/context fields:

- **Create (`POST /ai-profiles`)** — omit `braSize`, or send `null` / `""`, to skip it. Non-string values are `400 VALIDATION_ERROR`. Missing `braSize` must not break create.
- **Update (`PATCH /ai-profiles/{aiProfileId}`)** — owner `PERSONAL` only. `null` or `""` **clears** a previously stored `braSize`. Omitted fields are left unchanged. WARDROBE-80 fields stay independently writable.
- **Responses** — present only when a value is stored. Never `null`. List, get, create, and update all use this DTO.
- **Try-on** — when stored, copied into the Gemini prompt as `bra size: 34B`. Missing `braSize` is not mentioned and does not fail render.
- **Images** — `frontImageUrl` / `referenceImages` / `referenceImageUrls` are unchanged (WARDROBE-73 / WARDROBE-79).
- **GENERIC_MODEL** — catalog seeds do not set `braSize`. The field is for PERSONAL profiles.

PATCH example:

```http
PATCH /ai-profiles/{aiProfileId}
```

```json
{
  "braSize": "32C"
}
```

### Reference image GET URLs (WARDROBE-73) — Flutter contract

`referenceImages` stays the stored S3 object keys. List and get also add short-lived HTTPS GET URLs (same helper / TTL as clothing-item `originalImageUrl`: `createPresignedGetUrl`, `expiresIn` **900**). URLs are never written to Dynamo.

**Flutter WARDROBE-71 should read `frontImageUrl`.** Do not treat `referenceImages` as display URLs.

| Field | When present |
| --- | --- |
| `referenceImages` | Always (may be `[]`). S3 keys only — not HTTPS |
| `frontImageUrl` | When a frontal key exists and presign succeeds. Soft-omitted if presign fails or there are no refs |
| `referenceImageUrls` | When additional (non-frontal) keys exist and those presigns succeed. Map of `objectKey` → GET URL. Omitted when there are no extra angles or those presigns fail |

Frontal key: a `referenceImages` entry whose filename starts with `front.` (seeded GENERIC_MODEL `front.png`, WARDROBE-72). Otherwise the first key (PERSONAL attach order — upload filenames are `{nanoid}.{ext}`, not `front.*`). PERSONAL get/list/create also coerce a Dynamo String Set or `{ objectKey }` entry into keys before presigning (WARDROBE-79); GENERIC_MODEL catalog rows were already a string list.

A presign failure is logged and the URL field is omitted; list / get / create / attach still return `200` / `201`. Same pattern as item `originalImageUrl`.

Example — generic model picker row after a successful frontal presign:

```json
{
  "aiProfileId": "profile_generic_01",
  "type": "GENERIC_MODEL",
  "label": "Alex",
  "referenceImages": ["shared/ai-profiles/generic/alex/front.png"],
  "frontImageUrl": "https://...presigned GetObject for front.png...",
  "status": "READY",
  "heightCm": 175,
  "weightKg": 70,
  "clothingSize": "M",
  "ageYears": 28,
  "bodyType": "AVERAGE",
  "createdAt": "2026-09-06T00:00:00.000Z",
  "updatedAt": "2026-09-06T00:00:00.000Z"
}
```

Example — PERSONAL with a named frontal plus a side angle:

```json
{
  "aiProfileId": "profile_abc123xyz0",
  "type": "PERSONAL",
  "referenceImages": [
    "users/{uid}/ai-profiles/{aiProfileId}/side.jpg",
    "users/{uid}/ai-profiles/{aiProfileId}/front.jpg"
  ],
  "frontImageUrl": "https://...presigned GetObject for front.jpg...",
  "referenceImageUrls": {
    "users/{uid}/ai-profiles/{aiProfileId}/side.jpg": "https://...presigned GetObject for side.jpg..."
  },
  "status": "READY",
  "createdAt": "2026-09-06T08:00:00.000Z",
  "updatedAt": "2026-09-06T08:00:00.000Z"
}
```

Missing or other-user personal profiles return `404 AI_PROFILE_NOT_FOUND`. Missing tokens return `401 UNAUTHENTICATED`. Delete / upload / attach / PATCH on a generic model returns `403 UNAUTHORIZED`.

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

| `aiProfileId` | `label` | Placeholder S3 key | Seeded body context |
| --- | --- | --- | --- |
| `profile_generic_01` | Alex | `shared/ai-profiles/generic/alex/front.png` | `heightCm` 175, `weightKg` 70, `clothingSize` M, `ageYears` 28, `bodyType` AVERAGE |
| `profile_generic_02` | Jordan | `shared/ai-profiles/generic/jordan/front.png` | `heightCm` 168, `weightKg` 62, `clothingSize` S, `ageYears` 26, `bodyType` SLIM |
| `profile_generic_03` | Sam | `shared/ai-profiles/generic/sam/front.png` | `heightCm` 180, `weightKg` 78, `clothingSize` L, `ageYears` 30, `bodyType` ATHLETIC |
| `profile_generic_04` | Riley | `shared/ai-profiles/generic/riley/front.png` | `heightCm` 162, `weightKg` 58, `clothingSize` S, `ageYears` 24, `bodyType` PETITE |

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
      "referenceImages": ["shared/ai-profiles/generic/alex/front.png"],
      "frontImageUrl": "https://...presigned GetObject for front.png...",
      "status": "READY",
      "heightCm": 175,
      "weightKg": 70,
      "clothingSize": "M",
      "ageYears": 28,
      "bodyType": "AVERAGE",
      "createdAt": "2026-09-06T00:00:00.000Z",
      "updatedAt": "2026-09-06T00:00:00.000Z"
    }
  ]
}
```

The seed writes Dynamo rows only. It does **not** upload image bytes. Keys above are documented placeholders under a shared prefix — never commit model photos or API keys.

#### After deploy — upload real model images

1. Note `MediaBucketName` and `GenericModelCatalogIds` from the stack outputs.
2. Upload one full-body photo per model (JPEG/PNG/WebP/HEIC) to the exact placeholder key. Example:

```bash
BUCKET=$(aws cloudformation describe-stacks \
  --stack-name WardrobeStack-prod \
  --query "Stacks[0].Outputs[?OutputKey=='MediaBucketName'].OutputValue" \
  --output text)

aws s3 cp ./alex-front.png \
  "s3://$BUCKET/shared/ai-profiles/generic/alex/front.png" \
  --content-type image/png

aws s3 cp ./jordan-front.png \
  "s3://$BUCKET/shared/ai-profiles/generic/jordan/front.png" \
  --content-type image/png

aws s3 cp ./sam-front.png \
  "s3://$BUCKET/shared/ai-profiles/generic/sam/front.png" \
  --content-type image/png

aws s3 cp ./riley-front.png \
  "s3://$BUCKET/shared/ai-profiles/generic/riley/front.png" \
  --content-type image/png
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
referenceImages ["shared/ai-profiles/generic/alex/front.png"]
createdAt       2026-09-06T00:00:00.000Z
updatedAt       2026-09-06T00:00:00.000Z
```

Repeat for `02`–`04`. `referenceImages` is a Dynamo string set or list of strings (this stack writes a list).

### Later-ticket hooks

| Ticket | Hook |
| --- | --- |
| WARDROBE-47 | Secret `wardrobe/{stage}/gemini-try-on` (`tryOnSecretName`). Job type `RENDER_OUTFIT` on the dedicated outfit-render queue. See **Outfit try-on / render** above. |
| WARDROBE-114 | Inbox `USER#{uid}` / `EVENT#{eventId}` + optional secret `wardrobe/{stage}/firebase-fcm`. See **AI job-done events**. |

## DynamoDB keys

```text
PK                         SK                         GSI1PK                GSI1SK
USER#{uid}                 PROFILE
USER#{uid}                 ENTITLEMENT
USER#{uid}                 WARDROBE#{wardrobeId}
USER#{uid}                 AIPROFILE#{aiProfileId}    (omitted — sparse)
USER#{uid}                 SHOPPING#{itemId}          (24h TTL cache)
USER#{uid}                 EVENT#{eventId}            (30d TTL inbox)
USER#{uid}                 DEVICE#{deviceId}          (FCM token)
WARDROBE#{wardrobeId}      ITEM#{itemId}
WARDROBE#{wardrobeId}      OUTFIT#{outfitId}
WARDROBE#{wardrobeId}      OUTFIT#{outfitId}#WORN#{YYYY-MM-DD}
SHARE#{token}              SHARE                      SHARE#USER#{uid}      SHARE#{token}
AIPROFILE#GENERIC_MODEL    AIPROFILE#{aiProfileId}    TYPE#GENERIC_MODEL    AIPROFILE#{aiProfileId}
```

Access patterns:

```text
List caller's PERSONAL profiles     Query PK=USER#{uid} begins_with SK=AIPROFILE#
Get caller's PERSONAL profile       Get USER#{uid} / AIPROFILE#{id}
Get caller's entitlement            Get USER#{uid} / ENTITLEMENT
List job-done inbox                 Query PK=USER#{uid} begins_with SK=EVENT#
Get / ack one event                 Get/Update USER#{uid} / EVENT#{eventId}
Upsert / delete FCM device          Put/Delete USER#{uid} / DEVICE#{deviceId}
List GENERIC_MODEL (picker)         Query GSI1 PK=TYPE#GENERIC_MODEL
                                    (fallback: Query PK=AIPROFILE#GENERIC_MODEL)
Get GENERIC_MODEL                   Get AIPROFILE#GENERIC_MODEL / AIPROFILE#{id}
Get share by token                  Get SHARE#{token} / SHARE
List caller's shares (account wipe) Query GSI1 PK=SHARE#USER#{uid} begins_with SK=SHARE#
```

API responses never expose `PK` / `SK` / `GSI1PK` / `GSI1SK`.

## Project layout

```text
bin/app.ts
lib/wardrobe-stack.ts
lib/entitlements.ts    isolated WARDROBE-91 Superwall webhook wiring
lib/support-mail.ts    isolated WARDROBE-38 Resend wiring (rebase-friendly)
lib/wardrobe-pipeline-stack.ts
lib/wardrobe-stage.ts
cdk.json.example
scripts/ensure-cdk-json.js
scripts/seed-generic-models.ts   idempotent GENERIC_MODEL catalog writer (WARDROBE-45)
src/functions/
  health/
  me/                  owner-only entitlement GET + clear-content + delete-account (WARDROBE-36 / WARDROBE-91 / WARDROBE-103)
  events/              job-done inbox + FCM device registration (WARDROBE-114)
  entitlements-webhook/ public Superwall Svix webhook (WARDROBE-91)
  wardrobes/
  items/
  outfits/             CRUD + POST/GET render (WARDROBE-47) + append-only history (WARDROBE-85)
  shares/              item/outfit share tokens + public preview (WARDROBE-126)
  recommendations/     owner-only derived outfits; OpenAI (default) + rule-based fallback
  shopping-links/      owner-only related shopping (WARDROBE-96); OpenAI keywords + Bright Data SERP
  uploads/
  ai-profiles/         CRUD + PERSONAL refs (43/44); generic catalog seed (45); body context (80)
  processing/          Gemini helpers, bg-remove, classify, colour-detect, try-on, pipeline
  outfit-render/       SQS worker for RENDER_OUTFIT (WARDROBE-47)
  support/             WARDROBE-38 outbound contact/bug + Resend client + Svix verify
  support-webhook/     public inbound webhook entry (re-exports support/webhook)
src/shared/
  auth.ts
  dynamodb.ts
  entitlements.ts
  superwall-config.ts  wardrobe/{stage}/superwall JSON (WARDROBE-91 webhook + WARDROBE-103 optional cancel)
  errors.ts
  http.ts
  ids.ts
  logger.ts
  s3.ts
  secrets.ts
  sqs.ts
  svix.ts
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

Flutter **Contact us** / **Report a bug** forms POST through this API. Resend sends from a custom-domain address to the operator mailbox. Inbound mail on that domain is webhook-forwarded to the same mailbox.

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

Flutter UI is WARDROBE-34 (out of scope here). Configure DNS in the Resend dashboard — this repo only documents the records and webhook URL.

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
| `SUPPORT_FORWARD_TO` | Operator mailbox |

Lambdas never receive raw keys as environment variables in the deployed stack.

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/resend \
  --secret-string '{"apiKey":"re_your_key","webhookSecret":"whsec_your_signing_secret"}'
```

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/support-mail \
  --secret-string '{"fromEmail":"Wardrobe Support <support@your-domain>","forwardTo":"operator@your-mailbox"}'
```

A raw API key also works for `wardrobe/{stage}/resend` if `webhookSecret` / addresses are supplied in the other secret or as test env vars. All four fields may live in one JSON blob on either secret.

Stack outputs: `ResendSecretName`, `SupportMailSecretName`, `SupportWebhookUrl`.

### Domain DNS (operators — do not configure from this PR)

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
