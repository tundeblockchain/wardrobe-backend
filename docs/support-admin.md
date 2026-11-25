# Support inbox admin (WARDROBE-284)

Operator setup for the Stage 2 admin API. Do not commit secrets, Firebase private keys, or service-account JSON.

## SSM parameters

Set these per stage. The stack does not create the parameters; it only grants `ssm:GetParameter`.

1. `/wardrobe/<stage>/support/recipient` — support inbox address. Used as Reply-To on admin reply email. If unset, replies are still sent without Reply-To.
2. `/wardrobe/<stage>/support/app-link` — base URL for the "Open in Pocket Closet" link in reply email. The href is `<app-link>/support/{conversationId}` (trailing slash on the base is trimmed). If unset, the email is still sent without the link.

Optional CDK context / env overlay: `supportInboxAppLink` / `SUPPORT_INBOX_APP_LINK`. When set, that URL is injected as Lambda env and SSM is not required for the link.

Confirm WARDROBE-38 secrets are already populated: `wardrobe/<stage>/resend` (API key) and `wardrobe/<stage>/support-mail` `fromEmail` (verified sender). Admin replies reuse that sender; From is never changed.

## FCM reply push (WARDROBE-286 / WARDROBE-290)

Admin reply push reads the existing Secrets Manager secret `wardrobe/<stage>/firebase-fcm` (same JSON as job-done FCM). The stack imports it by name and does not create or own it. Expected value is a standard Google service-account JSON (`project_id`, `client_email`, `private_key`). Missing, empty, or invalid JSON skips push; the reply still returns 201. APNs development and production auth keys are already uploaded in Firebase.

WARDROBE-286 left an unused empty secret `wardrobe/<stage>/fcm-service-account`. After this change it is no longer referenced. Dev (`RemovalPolicy.DESTROY`) deletes it on deploy. Staging and production (`RemovalPolicy.RETAIN`) keep it; delete that empty secret by hand if desired. Never commit service-account JSON.

Example:

```bash
aws ssm put-parameter \
  --name /wardrobe/prod/support/app-link \
  --type String \
  --value "https://example.invalid/app"
```

## Granting the admin claim

Admin routes require a Firebase ID token whose custom claims include `admin === true`. The API Gateway Firebase authorizer validates the token; the Lambda checks the claim on every admin route.

Use the operator script. Credentials must come from the local environment (`GOOGLE_APPLICATION_CREDENTIALS` pointing at a service-account JSON that can call Firebase Auth). That file stays off the repository.

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json npm run support:grant-admin -- --uid <firebaseUid>
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json npm run support:grant-admin -- --email <email>
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json npm run support:grant-admin -- --uid <firebaseUid> --revoke
```

The script merges `admin: true` onto existing custom claims (or removes `admin` on `--revoke`). Other claims are left unchanged.

After a grant or revoke, the user must **sign out and sign in**, or otherwise refresh the ID token, before the claim appears on API requests. Cached tokens keep the previous claims until they are replaced.

## Auth and CORS

Admin route auth is enforced by the Firebase Bearer token plus the `admin` custom claim (API Gateway authorizer and an in-Lambda `admin === true` check on every admin route). API-level CORS currently allows `*` (same HTTP API config as the rest of the backend; methods include GET/POST and header `Authorization`). `supportInboxAllowedOrigins` is the media-bucket POST allowlist for screenshot uploads, not an admin-route restriction.
