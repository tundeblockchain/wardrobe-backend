# Digital Wardrobe Backend Architecture

## 1. Overview

This document defines the initial backend architecture for the Digital Wardrobe app.

The mobile app will be built in Flutter. Authentication will be handled by Firebase Authentication, while the application backend will run on AWS using a serverless architecture.

The initial product flow is:

1. User logs in.
2. User sees a list of wardrobes.
3. User can create a wardrobe by entering a wardrobe name.
4. User can open a wardrobe.
5. User can add clothing items to a wardrobe.
6. User can create outfits using items from a wardrobe.
7. AI-powered image processing, recommendations, and virtual try-on can be added in later phases.

The backend should be designed so that the core wardrobe experience works independently of the AI layer.

---

## 2. Technology Stack

### Client

- Flutter
- Firebase Authentication SDK

### Authentication

- Firebase Authentication

Potential login methods:

- Email/password
- Google
- Apple

### AWS Backend

- Amazon API Gateway
- AWS Lambda
- Amazon DynamoDB
- Amazon S3
- Amazon SQS
- AWS CloudWatch
- AWS Secrets Manager and/or Systems Manager Parameter Store

### Infrastructure

Recommended:

- AWS CDK
- TypeScript

All infrastructure should be defined as code rather than configured manually through the AWS console.

---

## 3. High-Level Architecture

```text
Flutter App
   |
   |-- Firebase Authentication
   |      |
   |      └── Firebase ID Token
   |
   v
AWS API Gateway
   |
   |-- Authentication / token validation
   |
   v
AWS Lambda
   |
   |------ DynamoDB
   |         |
   |         ├── Users
   |         ├── Wardrobes
   |         ├── Clothing Items
   |         └── Outfits
   |
   |------ S3
   |         |
   |         ├── Original clothing images
   |         ├── Processed clothing images
   |         └── AI-generated outfit images
   |
   └------ SQS
             |
             └── Worker Lambda
                    |
                    ├── Image processing
                    ├── AI classification
                    ├── Background removal
                    └── DynamoDB updates
```

Firebase owns user authentication.

AWS owns all application data.

---

## 4. Authentication Strategy

Firebase Authentication should be responsible for:

- User login
- Password handling
- Email verification
- Google sign-in
- Apple sign-in
- Authentication token creation

After the user logs in, Flutter obtains the Firebase ID token.

Flutter sends the token to AWS with every authenticated request.

Example:

```http
Authorization: Bearer <firebase-id-token>
```

API Gateway and/or a Lambda authorizer validates the token.

The backend then extracts the Firebase user ID:

```text
userId = decodedFirebaseToken.uid
```

The Firebase UID becomes the root identity for all user-owned resources.

### Important Security Rule

Never trust a `userId` supplied by the Flutter app as proof of ownership.

Avoid APIs such as:

```json
{
  "userId": "123",
  "wardrobeId": "abc"
}
```

Instead, derive the user ID from the validated authentication token.

```text
Firebase token
      ↓
Validated backend identity
      ↓
Firebase UID
      ↓
Backend checks resource ownership
```

Every wardrobe, item, outfit, upload, and AI profile must be checked against the authenticated Firebase UID.

---

## 5. Core Domain Model

The MVP requires four primary application entities:

- User
- Wardrobe
- Clothing Item
- Outfit

AI profiles and AI render jobs can be added later.

---

## 6. User Entity

Firebase already stores authentication-related information, so DynamoDB does not need to store passwords or duplicate Firebase authentication state.

The application may still maintain a lightweight user profile.

Example:

```json
{
  "userId": "firebase-uid-123",
  "email": "user@example.com",
  "displayName": "Sarah",
  "createdAt": "2026-09-03T18:30:00Z",
  "updatedAt": "2026-09-03T18:30:00Z"
}
```

Possible future fields:

```text
subscriptionPlan
defaultWardrobeId
preferredUnits
country
onboardingComplete
aiProfileId
```

These should only be added when required.

---

## 7. Wardrobe Entity

A user can own multiple wardrobes.

Examples:

```text
My Wardrobe
Work Clothes
Holiday Clothes
Winter Wardrobe
```

Example entity:

```json
{
  "wardrobeId": "wd_abc123",
  "userId": "firebase-uid-123",
  "name": "My Wardrobe",
  "createdAt": "2026-09-03T18:35:00Z",
  "updatedAt": "2026-09-03T18:35:00Z"
}
```

### Wardrobe API

```http
POST   /wardrobes
GET    /wardrobes
GET    /wardrobes/{wardrobeId}
PATCH  /wardrobes/{wardrobeId}
DELETE /wardrobes/{wardrobeId}
```

### Create Wardrobe

Request:

```http
POST /wardrobes
```

```json
{
  "name": "Summer Clothes"
}
```

Response:

```json
{
  "wardrobeId": "wd_abc123",
  "name": "Summer Clothes"
}
```

The backend should automatically associate the wardrobe with the authenticated user.

---

## 8. Clothing Item Entity

Clothing items will become one of the most important entities in the application.

Initial example:

```json
{
  "itemId": "item_xyz123",
  "wardrobeId": "wd_abc123",
  "userId": "firebase-uid-123",

  "name": "Black Nike T-Shirt",

  "category": "TOP",
  "subcategory": "TSHIRT",

  "colours": [
    "BLACK"
  ],

  "brand": "Nike",

  "image": {
    "originalKey": "users/firebase-uid-123/items/item_xyz123/original.jpg",
    "processedKey": "users/firebase-uid-123/items/item_xyz123/processed.png"
  },

  "processingStatus": "READY",

  "createdAt": "2026-09-03T18:45:00Z",
  "updatedAt": "2026-09-03T18:45:00Z"
}
```

---

## 9. Clothing Categories

Use controlled categories rather than unrestricted free-text categories.

Recommended top-level categories:

```text
TOP
BOTTOM
DRESS
OUTERWEAR
SHOES
ACCESSORY
BAG
```

Example subcategories:

```text
TOP
 ├── TSHIRT
 ├── SHIRT
 ├── BLOUSE
 ├── POLO
 ├── SWEATER
 └── HOODIE

BOTTOM
 ├── JEANS
 ├── TROUSERS
 ├── SHORTS
 └── SKIRT

OUTERWEAR
 ├── JACKET
 ├── COAT
 └── BLAZER
```

A controlled category system will improve:

- Filtering
- Outfit creation
- AI classification
- Outfit recommendations
- Virtual try-on logic
- Analytics

---

## 10. Clothing Item API

```http
POST   /wardrobes/{wardrobeId}/items
GET    /wardrobes/{wardrobeId}/items
GET    /wardrobes/{wardrobeId}/items/{itemId}
PATCH  /wardrobes/{wardrobeId}/items/{itemId}
DELETE /wardrobes/{wardrobeId}/items/{itemId}
```

Filtering can later be supported through query parameters.

Examples:

```http
GET /wardrobes/{wardrobeId}/items?category=TOP
```

```http
GET /wardrobes/{wardrobeId}/items?category=TOP&colour=BLACK
```

---

## 11. Image Storage

Images must not be stored in DynamoDB.

Use S3 for:

- Original wardrobe item photos
- Background-removed images
- Cropped images
- AI-generated wardrobe previews
- AI-generated outfit renders
- Future user reference images for AI avatars

Recommended path structure:

```text
users/{userId}/items/{itemId}/original.jpg
users/{userId}/items/{itemId}/processed.png

users/{userId}/outfits/{outfitId}/render.png

users/{userId}/ai-profiles/{profileId}/reference-1.jpg
```

S3 objects should remain private.

The application should use signed URLs where required.

---

## 12. Image Upload Flow

Do not upload the full image through API Gateway and Lambda.

Preferred flow:

```text
Flutter
   |
   | POST /uploads
   v
API Lambda
   |
   | Generate S3 pre-signed URL
   v
Flutter
   |
   | PUT image directly to S3
   v
S3
```

### Upload API

```http
POST /uploads
```

Request:

```json
{
  "contentType": "image/jpeg",
  "purpose": "WARDROBE_ITEM"
}
```

Response:

```json
{
  "uploadUrl": "https://...",
  "objectKey": "users/uid/uploads/uuid.jpg",
  "expiresIn": 900
}
```

Flutter then uploads the image directly to S3.

After the upload completes, Flutter creates the clothing item.

Example:

```http
POST /wardrobes/{wardrobeId}/items
```

```json
{
  "name": "Black T-Shirt",
  "category": "TOP",
  "imageKey": "users/uid/uploads/uuid.jpg"
}
```

---

## 13. Clothing Item Creation Flow

Initial MVP flow:

```text
Flutter camera
      |
      v
Photograph clothing item
      |
      v
POST /uploads
      |
      v
Lambda generates S3 pre-signed URL
      |
      v
Flutter uploads image directly to S3
      |
      v
POST /wardrobes/{wardrobeId}/items
      |
      v
Lambda
      |
      ├── Validate authenticated user
      ├── Validate wardrobe ownership
      ├── Generate item ID
      ├── Create DynamoDB record
      └── Optionally publish processing job to SQS
      |
      v
Return ClothingItem
```

---

## 14. Outfit Entity

For the first version, an outfit should simply be a saved combination of clothing item IDs.

Example:

```json
{
  "outfitId": "outfit_123",
  "wardrobeId": "wd_abc123",
  "userId": "firebase-uid-123",

  "name": "Friday Night",

  "items": [
    {
      "itemId": "item_top123",
      "slot": "TOP"
    },
    {
      "itemId": "item_bottom456",
      "slot": "BOTTOM"
    },
    {
      "itemId": "item_shoes789",
      "slot": "SHOES"
    }
  ],

  "createdAt": "2026-09-03T19:10:00Z",
  "updatedAt": "2026-09-03T19:10:00Z"
}
```

The first version of outfit creation does not need AI.

Example user flow:

```text
Choose Top
Choose Bottom
Choose Shoes
Choose Jacket
Save Outfit
```

---

## 15. Outfit API

```http
POST   /wardrobes/{wardrobeId}/outfits
GET    /wardrobes/{wardrobeId}/outfits
GET    /wardrobes/{wardrobeId}/outfits/{outfitId}
PATCH  /wardrobes/{wardrobeId}/outfits/{outfitId}
DELETE /wardrobes/{wardrobeId}/outfits/{outfitId}
```

The backend must verify that:

- The wardrobe belongs to the authenticated user.
- Every clothing item referenced by the outfit belongs to that wardrobe/user.

---

## 16. DynamoDB Design

Two reasonable approaches exist.

### Option A: Multiple Tables

Possible tables:

```text
Users
Wardrobes
Items
Outfits
```

This is simple and easy to understand.

### Option B: Single-Table Design

A single-table DynamoDB design is recommended once the access patterns are understood.

Example:

```text
PK                         SK
----------------------------------------------------
USER#123                   PROFILE

USER#123                   WARDROBE#wd1
USER#123                   WARDROBE#wd2

WARDROBE#wd1               ITEM#item1
WARDROBE#wd1               ITEM#item2
WARDROBE#wd1               ITEM#item3

WARDROBE#wd1               OUTFIT#outfit1
WARDROBE#wd1               OUTFIT#outfit2
```

Example wardrobe record:

```json
{
  "PK": "USER#abc",
  "SK": "WARDROBE#123",
  "entityType": "WARDROBE",
  "wardrobeId": "123",
  "name": "My Wardrobe"
}
```

Example clothing item record:

```json
{
  "PK": "WARDROBE#123",
  "SK": "ITEM#456",
  "entityType": "ITEM",
  "itemId": "456",
  "userId": "abc",
  "category": "TOP",
  "name": "White Shirt"
}
```

Example outfit record:

```json
{
  "PK": "WARDROBE#123",
  "SK": "OUTFIT#789",
  "entityType": "OUTFIT",
  "outfitId": "789",
  "userId": "abc",
  "name": "Friday Night"
}
```

---

## 17. Primary DynamoDB Access Patterns

The main access patterns are:

```text
Get user profile

Get all wardrobes belonging to a user

Get a specific wardrobe

Get all clothing items in a wardrobe

Get a specific clothing item

Get all outfits in a wardrobe

Get a specific outfit
```

These should drive the DynamoDB key design.

Avoid designing tables around arbitrary relational-style queries.

---

## 18. Lambda Structure

Avoid one large Lambda containing all backend logic.

A clean logical structure would be:

```text
/functions

    /wardrobes
        createWardrobe
        listWardrobes
        getWardrobe
        updateWardrobe
        deleteWardrobe

    /items
        createItem
        listItems
        getItem
        updateItem
        deleteItem

    /outfits
        createOutfit
        listOutfits
        getOutfit
        updateOutfit
        deleteOutfit

    /uploads
        createUploadUrl

    /processing
        processWardrobeItem
```

Recommended runtime:

```text
Node.js
TypeScript
```

Shared code should contain:

```text
authentication
validation
DynamoDB helpers
S3 helpers
SQS helpers
error handling
logging
API response formatting
```

---

## 19. SQS Processing Architecture

EventBridge is not required for the MVP.

SQS is sufficient for the asynchronous image-processing pipeline.

Recommended flow:

```text
Flutter uploads image to S3
        |
        v
Flutter creates clothing item
        |
        v
Create Item Lambda
        |
        ├── Write item to DynamoDB
        |
        └── Send message to SQS
                  |
                  v
           Processing Queue
                  |
                  v
             Worker Lambda
                  |
                  ├── Image processing
                  ├── AI classification
                  ├── Background removal
                  ├── Save processed image to S3
                  └── Update DynamoDB
```

Recommended queues:

```text
wardrobe-item-processing
wardrobe-item-processing-dlq
```

The processing queue should have a dead-letter queue.

---

## 20. SQS Message

Example processing message:

```json
{
  "jobType": "PROCESS_WARDROBE_ITEM",
  "userId": "firebase-uid-123",
  "wardrobeId": "wd_abc123",
  "itemId": "item_xyz123",
  "originalImageKey": "users/firebase-uid-123/items/item_xyz123/original.jpg"
}
```

The worker should still validate relevant data from DynamoDB rather than blindly trusting message contents.

---

## 21. Processing Status

Clothing items should support asynchronous processing states.

Recommended values:

```text
PENDING
PROCESSING
READY
FAILED
```

Example:

```json
{
  "processingStatus": "PROCESSING"
}
```

Flutter can display:

```text
Processing clothing item...
```

Once processing is complete:

```json
{
  "processingStatus": "READY"
}
```

If processing fails:

```json
{
  "processingStatus": "FAILED"
}
```

The app can later offer a retry action.

---

## 22. AI Metadata Hooks

AI does not need to be implemented in the first backend version, but the data model should leave space for it.

Example:

```json
{
  "ai": {
    "processingStatus": "READY",

    "detectedCategory": "TOP",
    "detectedSubcategory": "BLOUSE",

    "detectedColours": [
      "WHITE"
    ],

    "backgroundRemoved": true,

    "processedImageKey": "users/uid/items/item123/processed.png"
  }
}
```

Potential later processing:

```text
Original image
      |
      v
SQS
      |
      v
Worker Lambda
      |
      ├── Vision model
      ├── Garment classification
      ├── Colour detection
      ├── Background removal
      └── Image normalisation
      |
      v
Processed image in S3
      |
      v
DynamoDB metadata updated
```

---

## 23. Future AI Profile / Avatar Entity

The virtual try-on feature should be treated as a separate domain area.

Possible entity:

```json
{
  "aiProfileId": "profile_123",
  "userId": "uid123",

  "type": "PERSONAL",

  "referenceImages": [
    "users/uid123/ai-profiles/profile_123/reference-1.jpg",
    "users/uid123/ai-profiles/profile_123/reference-2.jpg"
  ],

  "status": "READY",

  "createdAt": "2026-09-03T19:30:00Z"
}
```

Possible profile types:

```text
PERSONAL
GENERIC_MODEL
```

`PERSONAL` represents an AI version of the user.

`GENERIC_MODEL` represents a generated or predefined model.

---

## 24. Future Outfit Render Data

An outfit can later include an AI-rendering section.

Example:

```json
{
  "render": {
    "status": "READY",
    "imageKey": "users/uid/outfits/outfit123/render.png",
    "aiProfileId": "profile123"
  }
}
```

Possible render states:

```text
PENDING
PROCESSING
READY
FAILED
```

---

## 25. EventBridge Decision

EventBridge is not required for the MVP.

SQS alone is sufficient for the current asynchronous processing requirements.

Use SQS when:

- One job needs to be processed asynchronously.
- Processing may take time.
- Retries are required.
- Failed jobs should move to a dead-letter queue.
- Backend processing must be decoupled from API request latency.

EventBridge may become useful later if the architecture needs:

- Multiple independent consumers for one event
- Event fan-out
- Analytics pipelines
- Audit events
- Notifications
- Scheduled jobs
- More complex event routing

For the initial version:

```text
API Lambda
    |
    v
   SQS
    |
    v
Worker Lambda
```

is sufficient.

---

## 26. API Summary

### Wardrobes

```http
POST   /wardrobes
GET    /wardrobes
GET    /wardrobes/{wardrobeId}
PATCH  /wardrobes/{wardrobeId}
DELETE /wardrobes/{wardrobeId}
```

### Clothing Items

```http
POST   /wardrobes/{wardrobeId}/items
GET    /wardrobes/{wardrobeId}/items
GET    /wardrobes/{wardrobeId}/items/{itemId}
PATCH  /wardrobes/{wardrobeId}/items/{itemId}
DELETE /wardrobes/{wardrobeId}/items/{itemId}
```

### Outfits

```http
POST   /wardrobes/{wardrobeId}/outfits
GET    /wardrobes/{wardrobeId}/outfits
GET    /wardrobes/{wardrobeId}/outfits/{outfitId}
PATCH  /wardrobes/{wardrobeId}/outfits/{outfitId}
DELETE /wardrobes/{wardrobeId}/outfits/{outfitId}
```

### Recommendations

```http
GET /wardrobes/{wardrobeId}/recommendations
```

Owner-only. Returns suggested outfits as `{ recommendations: [ { name?, items: [{ itemId, slot }] } ] }`. Does not persist outfits.

### Uploads

```http
POST /uploads
```

Future APIs may include:

```http
POST /ai-profiles
GET  /ai-profiles

POST /wardrobes/{wardrobeId}/outfits/{outfitId}/render
GET  /wardrobes/{wardrobeId}/outfits/{outfitId}/render
```

Outfit recommendations are implemented as:

```http
GET /wardrobes/{wardrobeId}/recommendations
```

---

## 27. Error Response Format

Use one consistent error model across all APIs.

Example:

```json
{
  "error": {
    "code": "WARDROBE_NOT_FOUND",
    "message": "Wardrobe not found."
  }
}
```

Potential codes:

```text
UNAUTHENTICATED
UNAUTHORIZED
VALIDATION_ERROR
WARDROBE_NOT_FOUND
ITEM_NOT_FOUND
OUTFIT_NOT_FOUND
UPLOAD_INVALID
PROCESSING_FAILED
INTERNAL_ERROR
```

Do not expose internal AWS errors or stack traces to the Flutter client.

---

## 28. API Response Conventions

Use ISO 8601 timestamps.

Example:

```text
2026-09-03T18:45:00Z
```

Use generated opaque IDs.

Examples:

```text
wd_abc123
item_xyz123
outfit_123
profile_123
```

Do not expose DynamoDB PK/SK implementation details to Flutter.

Flutter should work with application-level IDs only.

---

## 29. Security Requirements

At minimum:

- Validate every Firebase ID token.
- Derive user identity from the token.
- Validate ownership before every read/write.
- Keep S3 buckets private.
- Use pre-signed URLs for uploads/downloads where appropriate.
- Restrict pre-signed upload content types.
- Restrict maximum upload size.
- Do not expose DynamoDB directly to Flutter.
- Do not expose SQS directly to Flutter.
- Use IAM least privilege for every Lambda.
- Store secrets in Secrets Manager or Parameter Store.
- Encrypt DynamoDB and S3 using AWS-managed or customer-managed keys as appropriate.
- Log security-relevant failures without logging sensitive tokens.
- Validate all request bodies.
- Validate all route parameters.
- Add API throttling/rate limiting where appropriate.

---

## 30. Observability

Use CloudWatch for:

- Lambda logs
- Lambda errors
- API Gateway errors
- SQS queue depth
- SQS oldest message age
- Dead-letter queue messages
- Processing failures
- Lambda duration
- Lambda throttling

Important alarms should eventually include:

```text
Processing DLQ contains messages
Worker Lambda error rate is high
API Lambda error rate is high
SQS oldest message age exceeds threshold
```

---

## 31. MVP Build Order

Recommended implementation order:

### Phase 1 — Digital Wardrobe

1. Firebase Authentication
2. AWS infrastructure using CDK
3. API Gateway
4. Firebase token validation
5. DynamoDB
6. Create/list/update/delete wardrobes
7. S3 image upload flow
8. Create/list/update/delete clothing items
9. Create/list/update/delete outfits
10. Flutter outfit builder

### Phase 2 — Smart Wardrobe

11. SQS processing queue
12. Worker Lambda
13. Background removal
14. AI clothing classification
15. Colour/category detection
16. Smart filtering
17. AI outfit recommendations

### Phase 3 — Virtual Dressing Room

18. AI profiles
19. User reference images
20. Generic AI models
21. AI outfit rendering
22. Virtual try-on
23. Persistent digital version/avatar of the user

The product progression is:

```text
Phase 1
Digital Wardrobe
       |
       v
Phase 2
Smart Wardrobe
       |
       v
Phase 3
Virtual Dressing Room
```

---

## 32. Initial Screen-to-Backend Mapping

### Login Screen

Flutter:

```text
Firebase Authentication
```

No AWS application API is required before authentication.

---

### Wardrobe List Screen

```http
GET /wardrobes
```

If no wardrobes exist, display the create-wardrobe option.

---

### Create Wardrobe Screen

Simple form:

```text
Wardrobe Name
```

Submit:

```http
POST /wardrobes
```

---

### Wardrobe Detail Screen

Load items:

```http
GET /wardrobes/{wardrobeId}/items
```

Load outfits:

```http
GET /wardrobes/{wardrobeId}/outfits
```

Main actions:

```text
Add Item
Create Outfit
```

---

### Add Item Screen

Flow:

```text
Take/select photo
      |
      v
POST /uploads
      |
      v
Upload directly to S3
      |
      v
Enter/confirm clothing metadata
      |
      v
POST /wardrobes/{wardrobeId}/items
```

---

### Create Outfit Screen

Load wardrobe clothing:

```http
GET /wardrobes/{wardrobeId}/items
```

User selects clothing for outfit slots.

Submit:

```http
POST /wardrobes/{wardrobeId}/outfits
```

---

## 33. Recommended Initial AWS Resource Set

The MVP AWS stack should contain approximately:

```text
API Gateway

Lambda:
- Firebase Authorizer / Authentication
- Wardrobe API
- Item API
- Outfit API
- Upload API
- Processing Worker

DynamoDB:
- Application table

S3:
- Wardrobe media bucket

SQS:
- Wardrobe item processing queue
- Wardrobe item processing dead-letter queue

CloudWatch:
- Logs
- Metrics
- Alarms

Secrets Manager / Parameter Store:
- External API credentials
- AI provider credentials when required (Gemini background-removal, Gemini colour detection, optional classifier / recommender)
```

Whether individual API operations use separate Lambdas or grouped domain Lambdas can be decided during implementation.

---

## 34. Current Architecture Decision

The current recommended architecture is:

```text
Flutter
   |
   v
Firebase Authentication
   |
   | Firebase ID token
   v
API Gateway
   |
   v
Lambda
   |
   ├── DynamoDB
   ├── S3
   └── SQS
          |
          v
      Worker Lambda
```

Supporting services:

```text
CloudWatch
Secrets Manager / Parameter Store
AWS CDK
```

EventBridge is intentionally excluded from the MVP because SQS satisfies the current asynchronous processing requirements.

---

## 35. Design Principles

The backend should follow these principles:

1. Keep authentication separate from application data.
2. Never trust client-supplied ownership information.
3. Store binary media in S3, not DynamoDB.
4. Upload images directly from Flutter to S3 using pre-signed URLs.
5. Keep AI processing asynchronous.
6. Use SQS for durable processing and retries.
7. Keep the initial outfit model simple.
8. Do not make the MVP dependent on AI.
9. Use controlled clothing categories.
10. Define infrastructure using AWS CDK.
11. Design DynamoDB around explicit access patterns.
12. Add EventBridge only when event fan-out/routing genuinely requires it.
13. Treat the virtual dressing room as a later domain rather than mixing it into the initial wardrobe CRUD model.

---

## 36. Next Backend Design Work

The next useful backend design step is to formalise the contract in more detail:

- Exact DynamoDB PK/SK schema
- Required GSIs
- Exact API request models
- Exact API response models
- Validation rules
- Pagination approach
- Firebase JWT validation mechanism
- Lambda authorizer implementation
- S3 bucket policies
- Pre-signed upload restrictions
- SQS visibility timeout and retry policy
- Dead-letter queue configuration
- CDK project structure
- Development, staging, and production environments
- API versioning strategy

Once those are defined, the Flutter application can be developed against a stable backend contract.
