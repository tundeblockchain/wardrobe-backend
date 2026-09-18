import { parseProductTiers, ProductTierMap } from './entitlements';
import { parseJsonObjectOrString } from './secrets';

/**
 * Secrets Manager JSON for `wardrobe/{stage}/superwall`.
 *
 * WARDROBE-91: `webhookSecret` + optional `productTiers`.
 * WARDROBE-103: optional Stripe / Play cancel credentials. Superwall has no
 * subscription-cancel API; App Store has none either. Placeholders only in CDK.
 */
export interface PlayServiceAccount {
  clientEmail: string;
  privateKey: string;
  privateKeyId?: string;
  tokenUri?: string;
}

export interface SuperwallSecretConfig {
  webhookSecret?: string;
  productTiers: ProductTierMap;
  stripeSecretKey?: string;
  stripeApiBase?: string;
  playPackageName?: string;
  playServiceAccount?: PlayServiceAccount;
}

export function parseSuperwallSecret(secretString: string): SuperwallSecretConfig {
  const parsed = parseJsonObjectOrString(secretString);
  if (typeof parsed === 'string') {
    return { webhookSecret: parsed, productTiers: {} };
  }

  return {
    webhookSecret: firstString(parsed, [
      'webhookSecret',
      'webhook_secret',
      'signingSecret',
      'SUPERWALL_WEBHOOK_SECRET',
    ]),
    productTiers: parseProductTiers(
      parsed.productTiers ?? parsed.product_tiers ?? parsed.products,
    ),
    stripeSecretKey: firstString(parsed, [
      'stripeSecretKey',
      'stripe_secret_key',
      'STRIPE_SECRET_KEY',
    ]),
    stripeApiBase: firstString(parsed, [
      'stripeApiBase',
      'stripe_api_base',
      'STRIPE_API_BASE',
    ]),
    playPackageName: firstString(parsed, [
      'playPackageName',
      'play_package_name',
      'packageName',
      'PLAY_PACKAGE_NAME',
    ]),
    playServiceAccount: parsePlayServiceAccount(
      parsed.playServiceAccount ??
        parsed.play_service_account ??
        parsed.googlePlayServiceAccount,
    ),
  };
}

export function looksLikePlaceholderCredential(value: string): boolean {
  const lower = value.trim().toLowerCase();
  if (!lower) {
    return true;
  }
  return (
    lower.includes('placeholder') ||
    lower.includes('replace the generated') ||
    lower.includes('your-') ||
    lower.includes('your_') ||
    lower.includes('your.') ||
    lower.includes('changeme') ||
    lower.includes('<api') ||
    lower === 'todo'
  );
}

function parsePlayServiceAccount(value: unknown): PlayServiceAccount | undefined {
  let record = asRecord(value);
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      record = asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (!record) {
    return undefined;
  }

  const clientEmail = firstString(record, [
    'clientEmail',
    'client_email',
    'client_email_address',
  ]);
  const privateKey = firstString(record, ['privateKey', 'private_key']);
  if (!clientEmail || !privateKey) {
    return undefined;
  }

  const account: PlayServiceAccount = {
    clientEmail,
    privateKey: privateKey.replace(/\\n/g, '\n'),
  };
  const privateKeyId = firstString(record, ['privateKeyId', 'private_key_id']);
  if (privateKeyId) {
    account.privateKeyId = privateKeyId;
  }
  const tokenUri = firstString(record, ['tokenUri', 'token_uri']);
  if (tokenUri) {
    account.tokenUri = tokenUri;
  }
  return account;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function firstString(
  record: Record<string, unknown>,
  keysToTry: string[],
): string | undefined {
  for (const key of keysToTry) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
