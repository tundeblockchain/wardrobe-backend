import {
  CHECKOUT_SESSION_ID_PLACEHOLDER,
  checkoutCancelUrl,
  checkoutReturnUrls,
  checkoutSuccessUrl,
  isAllowlistedHttpsOrigin,
  normalizeBillingWebOrigin,
  originsEqualExactly,
  portalReturnUrl,
  resolveBillingReturnOrigin,
  resolveBillingWebOrigin,
} from '../../src/shared/billing-urls';
import { Errors } from '../../src/shared/errors';

const CONFIGURED = 'https://app.example';

describe('billing return URLs (WARDROBE-198)', () => {
  const originalOrigin = process.env.BILLING_WEB_ORIGIN;
  const originalAllowlist = process.env.SUPPORT_CONTACT_ALLOWED_ORIGINS;

  afterEach(() => {
    if (originalOrigin === undefined) {
      delete process.env.BILLING_WEB_ORIGIN;
    } else {
      process.env.BILLING_WEB_ORIGIN = originalOrigin;
    }
    if (originalAllowlist === undefined) {
      delete process.env.SUPPORT_CONTACT_ALLOWED_ORIGINS;
    } else {
      process.env.SUPPORT_CONTACT_ALLOWED_ORIGINS = originalAllowlist;
    }
  });

  it('does not default an empty origin to any domain', () => {
    expect(normalizeBillingWebOrigin(undefined)).toBeUndefined();
    expect(normalizeBillingWebOrigin('  ')).toBeUndefined();
    expect(normalizeBillingWebOrigin('http://app.example')).toBeUndefined();
    expect(normalizeBillingWebOrigin(CONFIGURED + '/')).toBe(CONFIGURED);
  });

  it('throws BILLING_NOT_CONFIGURED when BILLING_WEB_ORIGIN is missing', () => {
    delete process.env.BILLING_WEB_ORIGIN;
    expect(() => resolveBillingWebOrigin()).toThrow(Errors.billingNotConfigured());
  });

  it('builds success_url with the literal Stripe session placeholder', () => {
    const urls = checkoutReturnUrls(CONFIGURED);
    expect(urls.successUrl).toBe(
      `${CONFIGURED}/app/billing/success?session_id=${CHECKOUT_SESSION_ID_PLACEHOLDER}`,
    );
    expect(urls.successUrl).toContain('{CHECKOUT_SESSION_ID}');
    expect(urls.cancelUrl).toBe(`${CONFIGURED}/app/billing/cancel`);
    expect(checkoutSuccessUrl('https://preview.example')).toBe(
      'https://preview.example/app/billing/success?session_id={CHECKOUT_SESSION_ID}',
    );
    expect(checkoutCancelUrl('https://preview.example')).toBe(
      'https://preview.example/app/billing/cancel',
    );
  });

  it('reads BILLING_WEB_ORIGIN from env', () => {
    process.env.BILLING_WEB_ORIGIN = 'https://env.example/';
    expect(resolveBillingWebOrigin()).toBe('https://env.example');
  });

  it('builds the Billing Portal return URL from the web origin', () => {
    expect(portalReturnUrl(CONFIGURED)).toBe(`${CONFIGURED}/app/settings#plan`);
    expect(portalReturnUrl('https://preview.example/')).toBe(
      'https://preview.example/app/settings#plan',
    );
  });

  it('uses the configured domain when Origin is missing', () => {
    expect(
      resolveBillingReturnOrigin({
        configured: CONFIGURED,
        requestOrigin: undefined,
        allowlist: [CONFIGURED],
      }),
    ).toBe(CONFIGURED);
  });

  it('uses an allowlisted https Origin', () => {
    expect(
      resolveBillingReturnOrigin({
        configured: CONFIGURED,
        requestOrigin: 'https://preview.example',
        allowlist: ['https://preview.example'],
      }),
    ).toBe('https://preview.example');
  });

  it('rejects a non-https Origin and falls back to the configured base', () => {
    expect(
      resolveBillingReturnOrigin({
        configured: CONFIGURED,
        requestOrigin: 'http://preview.example',
        allowlist: ['http://preview.example', 'https://preview.example'],
      }),
    ).toBe(CONFIGURED);
  });

  it('rejects lookalike prefix and suffix Origins', () => {
    const allowlist = ['https://custom.com'];
    expect(
      isAllowlistedHttpsOrigin('https://evil-custom.com', allowlist),
    ).toBe(false);
    expect(isAllowlistedHttpsOrigin('https://custom.com.evil.com', allowlist)).toBe(
      false,
    );
    expect(isAllowlistedHttpsOrigin('https://notcustom.com', allowlist)).toBe(
      false,
    );
    expect(isAllowlistedHttpsOrigin('https://custom.com.attacker.com', allowlist)).toBe(
      false,
    );
    expect(originsEqualExactly('https://evil-custom.com', 'https://custom.com')).toBe(
      false,
    );
    expect(
      resolveBillingReturnOrigin({
        configured: CONFIGURED,
        requestOrigin: 'https://evil-custom.com',
        allowlist: ['https://custom.com'],
      }),
    ).toBe(CONFIGURED);
    expect(
      resolveBillingReturnOrigin({
        configured: CONFIGURED,
        requestOrigin: 'https://prefixcustom.com',
        allowlist: ['https://custom.com'],
      }),
    ).toBe(CONFIGURED);
  });

  it('treats https default port 443 as the same origin', () => {
    expect(
      originsEqualExactly('https://custom.com', 'https://custom.com:443'),
    ).toBe(true);
    expect(
      isAllowlistedHttpsOrigin('https://custom.com:443', ['https://custom.com']),
    ).toBe(true);
    expect(
      isAllowlistedHttpsOrigin('https://custom.com:444', ['https://custom.com']),
    ).toBe(false);
  });
});
