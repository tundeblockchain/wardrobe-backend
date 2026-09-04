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
| CloudWatch | Lambda logs and a DLQ alarm |
| Secrets Manager | Firebase project ID |

Working in this first cut:

- `GET /health` (no auth)
- Wardrobe CRUD
- `POST /uploads` (S3 pre-signed PUT URL)

Stubbed for the next pass:

- Clothing item APIs
- Outfit APIs
- Processing worker (logs the SQS message only)

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

```http
POST   /wardrobes
GET    /wardrobes
GET    /wardrobes/{wardrobeId}
PATCH  /wardrobes/{wardrobeId}
DELETE /wardrobes/{wardrobeId}
```

Create body:

```json
{ "name": "Summer Clothes" }
```

### Uploads

```http
POST /uploads
```

```json
{
  "contentType": "image/jpeg",
  "purpose": "WARDROBE_ITEM"
}
```

The client then `PUT`s the image directly to `uploadUrl`.

### Items and outfits

Routes exist and require a valid Firebase token. They currently return:

```json
{
  "error": {
    "code": "NOT_IMPLEMENTED",
    "message": "..."
  }
}
```

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
  processing/
src/shared/
  auth.ts
  dynamodb.ts
  errors.ts
  http.ts
  ids.ts
  logger.ts
  s3.ts
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

1. Clothing item CRUD and SQS job on create
2. Outfit CRUD with wardrobe/item ownership checks
3. Worker: processing status updates (AI later)
4. Pagination, download pre-signed URLs, and environment-specific alarms
