# Digital Wardrobe Backend

Serverless AWS backend for the Digital Wardrobe app. Infrastructure is defined with AWS CDK in TypeScript.

The Flutter app authenticates with Firebase. This API validates Firebase ID tokens and stores application data in AWS.

## What this starter includes

| Resource | Purpose |
| --- | --- |
| HTTP API Gateway | Public API with a Firebase Lambda authorizer |
| Lambda (domain handlers) | Health, wardrobes, items, outfits, uploads, processing |
| DynamoDB | Single-table design (`PK` / `SK`) |
| S3 | Private media bucket with CORS for pre-signed uploads |
| SQS + DLQ | Async clothing-item processing pipeline |
| CloudWatch | Lambda logs plus SQS depth, oldest-message, and DLQ alarms |
| Secrets Manager | Firebase project ID, background-removal API key |

Working in this first cut:

- `GET /health` (no auth)
- Wardrobe CRUD
- Clothing item CRUD (nested under a wardrobe); create enqueues `PROCESS_WARDROBE_ITEM` and returns `PENDING`
- Outfit CRUD (nested under a wardrobe)
- `POST /uploads` (S3 pre-signed PUT URL)
- Processing worker (Dynamo-validated `PENDING` → `PROCESSING` → `READY` / `FAILED`; background removal writes `processed.png`; classification hooks are no-op)

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

Background removal reads its provider credential from Secrets Manager (plain API key, or JSON `{ "apiKey", "endpoint" }`). Optionally set CDK context / env `backgroundRemovalEndpoint` / `BACKGROUND_REMOVAL_ENDPOINT` if the endpoint is not in the secret:

```bash
aws secretsmanager put-secret-value \
  --secret-id wardrobe/prod/background-removal-api-key \
  --secret-string '{"apiKey":"your-provider-key","endpoint":"https://your-rembg-endpoint"}'
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

Identity comes from the Firebase authorizer (`getUserId`). The wardrobe must belong to that user before any item operation. Body `userId` is ignored.

```http
POST   /wardrobes/{wardrobeId}/items
GET    /wardrobes/{wardrobeId}/items
GET    /wardrobes/{wardrobeId}/items/{itemId}
PATCH  /wardrobes/{wardrobeId}/items/{itemId}
DELETE /wardrobes/{wardrobeId}/items/{itemId}
```

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

Create writes the DynamoDB item first, then sends `PROCESS_WARDROBE_ITEM` to the processing queue (`{ jobType, userId, wardrobeId, itemId, originalImageKey }`). Identity in that message comes from the Firebase authorizer, never from a body `userId`. Create returns `201` with the Flutter `ClothingItem` DTO (`itemId`, `wardrobeId`, `name`, `category`, optional `subcategory` / `colours` / `brand`, `image.originalKey`, `processingStatus: PENDING`, ISO 8601 timestamps). If enqueue fails, the request fails with `500 INTERNAL_ERROR` and the item is rolled back so the client can retry. List returns `{ "items": [...] }`. Missing or other-user wardrobes return `404` `WARDROBE_NOT_FOUND`. Missing items return `404` `ITEM_NOT_FOUND`. Delete returns `204`.

### Processing worker

The processing Lambda consumes `wardrobe-item-processing`. DynamoDB is the source of truth: the worker reloads the clothing item and checks `userId`, `wardrobeId`, `itemId`, and `originalImageKey` before doing work. It does not trust the SQS body alone.

Status machine:

```text
PENDING → PROCESSING → READY     pipeline success
        → FAILED                 permanent / validation errors
```

Poison messages (invalid JSON, unknown `jobType`, missing item, owner mismatch) are acked and dropped. An `originalImageKey` mismatch sets `FAILED` then acks.

Retries use the existing queue (WARDROBE-15): Lambda timeout **60s**, visibility timeout **120s** (visibility must stay greater than the timeout), `maxReceiveCount: 3`, then the DLQ + CloudWatch alarms. Retryable DynamoDB / provider / S3 errors are returned as SQS batch item failures so the message is redelivered.

Background removal (WARDROBE-18) reads the Dynamo-validated `originalImageKey` from the private media bucket, calls an injectable rembg HTTP client (Secrets Manager credential; unit tests mock the client — no live provider in CI), writes `users/{userId}/items/{itemId}/processed.png`, and updates DynamoDB:

- `processedKey` — Flutter `ClothingItem.image.processedKey`
- `ai.backgroundRemoved = true`
- `ai.processedImageKey` — architecture metadata (merged into any existing `ai` map)

The original object is kept. Permanent rembg / missing-image failures throw `PermanentProcessingError` so the worker sets `FAILED`. Transient failures throw `RetryableProcessingError` for SQS retry then DLQ.

Later hooks stay no-op stubs:

1. Background removal (WARDROBE-18) — implemented
2. AI classification (WARDROBE-19)
3. Colour / category detection (WARDROBE-20)

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
lib/wardrobe-pipeline-stack.ts
lib/wardrobe-stage.ts
cdk.json.example
scripts/ensure-cdk-json.js
src/functions/
  health/
  wardrobes/
  items/
  outfits/
  uploads/
  processing/          handler, rembg hook, pipeline stubs, retry/poison errors
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

1. Phase-2: background removal / AI classification / colour (WARDROBE-18–20)
2. Pagination, download pre-signed URLs, and environment-specific alarms
