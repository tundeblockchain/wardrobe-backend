# Support inbox admin (WARDROBE-284)

Operator setup for the Stage 2 admin API. Do not commit secrets, Firebase private keys, or service-account JSON.

## SSM parameters

Set these per stage. The stack does not create the parameters; it only grants `ssm:GetParameter`.

1. `/wardrobe/<stage>/support/recipient` — support inbox address. Used as Reply-To on admin reply email. If unset, replies are still sent without Reply-To.
2. `/wardrobe/<stage>/support/app-link` — "Open in Pocket Closet" URL included in reply email. If unset, the email is still sent without the link.

Optional CDK context / env overlay: `supportInboxAppLink` / `SUPPORT_INBOX_APP_LINK`. When set, that URL is injected as Lambda env and SSM is not required for the link.

Confirm WARDROBE-38 secrets are already populated: `wardrobe/<stage>/resend` (API key) and `wardrobe/<stage>/support-mail` `fromEmail` (verified sender). Admin replies reuse that sender; From is never changed.

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

## CORS

HTTP API CORS stays `allowOrigins: ['*']` with methods including GET/POST and header `Authorization` (mobile + public routes). The admin Lambda is given the same `supportInboxAllowedOrigins` list as public support (Netlify site + localhost).
