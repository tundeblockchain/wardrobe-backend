# Digital Wardrobe Backend

Serverless AWS backend for the Digital Wardrobe app. Infrastructure is defined with AWS CDK in TypeScript.

The Flutter app authenticates with Firebase. This API validates Firebase ID tokens and stores application data in AWS.

## What this starter includes

| Resource | Purpose |
| --- | --- |
| HTTP API Gateway | Public API with a Firebase Lambda authorizer |
| Lambda (domain handlers) | Health, wardrobes, items, outfits, recommendations, uploads, processing |
| DynamoDB | Single-table design (`PK` / `SK`) |
| S3 | Private media bucket with CORS for pre-signed uploads |
| SQS + DLQ | Async clothing-item processing pipeline |
| CloudWatch | Lambda logs plus SQS depth, oldest-message, and DLQ alarms |
| Secrets Manager | Firebase project ID, Gemini background-removal, Gemini garment-classification, Gemini colour-detection, and OpenAI recommender credentials (placeholders) |

Working in this first cut:

- `GET /health` (no auth)
- Wardrobe CRUD
- Clothing item CRUD (nested under a wardrobe); create enqueues `PROCESS_WARDROBE_ITEM` and returns `PENDING`
- Outfit CRUD (nested under a wardrobe)
- Owner-only outfit recommendations (derived, never auto-saved)
- `POST /uploads` (S3 pre-signed PUT URL)
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

Create writes the DynamoDB item first, then sends `PROCESS_WARDROBE_ITEM` to the processing queue (`{ jobType, userId, wardrobeId, itemId, originalImageKey }`). Identity in that message comes from the Firebase authorizer, never from a body `userId`. Create returns `201` with the Flutter `ClothingItem` DTO (`itemId`, `wardrobeId`, `name`, `category`, optional `subcategory` / `colours` / `brand`, `image.originalKey`, `processingStatus: PENDING`, ISO 8601 timestamps). If enqueue fails, the request fails with `500 INTERNAL_ERROR` and the item is rolled back so the client can retry. List returns `{ "items": [...] }` (Flutter `ItemListResponse`). Missing or other-user wardrobes return `404` `WARDROBE_NOT_FOUND`. Missing items return `404` `ITEM_NOT_FOUND`. Delete returns `204`.

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

Create returns `201` with the Flutter `Outfit` DTO (`outfitId`, `wardrobeId`, `name`, `items[{itemId, slot}]`, ISO 8601 `createdAt` / `updatedAt`). List returns `{ "outfits": [...] }`. Missing or other-user wardrobes return `404` `WARDROBE_NOT_FOUND`. Missing outfits return `404` `OUTFIT_NOT_FOUND`. Referenced items that are not in the wardrobe return `404` `ITEM_NOT_FOUND`. Delete returns `204`. Phase-1 outfits do not include AI or render fields.

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

## DynamoDB keys

```text
PK                         SK
USER#{uid}                 WARDROBE#{wardrobeId}
WARDROBE#{wardrobeId}      ITEM#{itemId}
WARDROBE#{wardrobeId}      OUTFIT#{outfitId}
```

API responses never expose `PK` / `SK`.

## Project layout

```text
bin/app.ts
lib/wardrobe-stack.ts
lib/support-mail.ts    isolated WARDROBE-38 Resend wiring (rebase-friendly)
lib/wardrobe-pipeline-stack.ts
lib/wardrobe-stage.ts
cdk.json.example
scripts/ensure-cdk-json.js
src/functions/
  health/
  wardrobes/
  items/
  outfits/
  recommendations/     owner-only derived outfits; OpenAI (default) + rule-based fallback
  uploads/
  processing/          handler, Gemini helpers, bg-remove, classify, colour-detect, pipeline, retry/poison errors
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
2. Pagination, download pre-signed URLs, and environment-specific alarms

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
