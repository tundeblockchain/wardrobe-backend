import {
  looksLikePlaceholderCredential,
  parseSuperwallSecret,
} from '../../src/shared/superwall-config';

describe('parseSuperwallSecret (WARDROBE-91 / WARDROBE-103)', () => {
  it('treats a raw string as the webhook signing secret', () => {
    expect(parseSuperwallSecret('whsec_only')).toEqual({
      webhookSecret: 'whsec_only',
      productTiers: {},
    });
  });

  it('parses webhook, productTiers, and optional cancel credentials', () => {
    expect(
      parseSuperwallSecret(
        JSON.stringify({
          webhookSecret: 'whsec_sign',
          productTiers: { 'sku.premium.month': 'PREMIUM' },
          stripeSecretKey: 'sk_test_123',
          playPackageName: 'app.wardrobe.android',
          playServiceAccount: {
            client_email: 'play@example.iam.gserviceaccount.com',
            private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
            private_key_id: 'key-1',
          },
        }),
      ),
    ).toEqual({
      webhookSecret: 'whsec_sign',
      productTiers: { 'sku.premium.month': 'PREMIUM' },
      stripeSecretKey: 'sk_test_123',
      playPackageName: 'app.wardrobe.android',
      playServiceAccount: {
        clientEmail: 'play@example.iam.gserviceaccount.com',
        privateKey:
          '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
        privateKeyId: 'key-1',
      },
    });
  });

  it('does not invent product IDs when productTiers is empty', () => {
    const parsed = parseSuperwallSecret(
      JSON.stringify({ webhookSecret: 'whsec_sign', productTiers: {} }),
    );
    expect(parsed.productTiers).toEqual({});
    expect(JSON.stringify(parsed)).not.toContain('com.example');
  });

  it('detects placeholder cancel credentials', () => {
    expect(looksLikePlaceholderCredential('your.android.package')).toBe(true);
    expect(looksLikePlaceholderCredential('sk_your_stripe_secret')).toBe(true);
    expect(looksLikePlaceholderCredential('sk_test_live_value')).toBe(false);
  });
});
