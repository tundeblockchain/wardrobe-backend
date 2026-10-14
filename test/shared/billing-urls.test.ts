import {
  CHECKOUT_SESSION_ID_PLACEHOLDER,
  DEFAULT_BILLING_WEB_ORIGIN,
  checkoutCancelUrl,
  checkoutReturnUrls,
  checkoutSuccessUrl,
  normalizeBillingWebOrigin,
  resolveBillingWebOrigin,
} from '../../src/shared/billing-urls';

describe('billing return URLs (WARDROBE-189)', () => {
  const original = process.env.BILLING_WEB_ORIGIN;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.BILLING_WEB_ORIGIN;
    } else {
      process.env.BILLING_WEB_ORIGIN = original;
    }
  });

  it('defaults the web origin and strips trailing slashes', () => {
    expect(normalizeBillingWebOrigin(undefined)).toBe(DEFAULT_BILLING_WEB_ORIGIN);
    expect(normalizeBillingWebOrigin('  ')).toBe(DEFAULT_BILLING_WEB_ORIGIN);
    expect(normalizeBillingWebOrigin('https://preview.example/')).toBe(
      'https://preview.example',
    );
  });

  it('builds success_url with the literal Stripe session placeholder', () => {
    const urls = checkoutReturnUrls(DEFAULT_BILLING_WEB_ORIGIN);
    expect(urls.successUrl).toBe(
      `${DEFAULT_BILLING_WEB_ORIGIN}/app/billing/success?session_id=${CHECKOUT_SESSION_ID_PLACEHOLDER}`,
    );
    expect(urls.successUrl).toContain('{CHECKOUT_SESSION_ID}');
    expect(urls.cancelUrl).toBe(`${DEFAULT_BILLING_WEB_ORIGIN}/app/billing/cancel`);
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
});
