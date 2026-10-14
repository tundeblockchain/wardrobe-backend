import { portalReturnUrl } from '../../src/shared/billing-urls';
import { Errors } from '../../src/shared/errors';
import {
  assertStripePortalEligible,
  createBillingPortalSession,
  resolveStripePortalConfigurationId,
} from '../../src/shared/stripe-portal';

const SECRET_KEY = 'sk_test_DO_NOT_LOG_THIS_VALUE_9f3a';

describe('stripe portal helpers (WARDROBE-191)', () => {
  const original = process.env.STRIPE_PORTAL_CONFIGURATION_ID;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.STRIPE_PORTAL_CONFIGURATION_ID;
    } else {
      process.env.STRIPE_PORTAL_CONFIGURATION_ID = original;
    }
  });

  it('allows only an active Stripe paid tier', () => {
    expect(() =>
      assertStripePortalEligible({
        tier: 'PREMIUM',
        source: 'stripe',
        store: 'STRIPE',
      }),
    ).not.toThrow();

    expect(() =>
      assertStripePortalEligible({
        tier: 'BASIC',
        source: 'ios',
        store: 'APP_STORE',
      }),
    ).toThrow(Errors.notStripePlan('ios'));

    try {
      assertStripePortalEligible({ tier: 'FREE', status: 'NONE' });
      throw new Error('expected NOT_STRIPE_PLAN');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'NOT_STRIPE_PLAN',
        statusCode: 409,
        source: null,
      });
    }
  });

  it('reads an optional portal configuration id from env', () => {
    delete process.env.STRIPE_PORTAL_CONFIGURATION_ID;
    expect(resolveStripePortalConfigurationId()).toBeUndefined();

    process.env.STRIPE_PORTAL_CONFIGURATION_ID = '  bpc_env  ';
    expect(resolveStripePortalConfigurationId()).toBe('bpc_env');
  });

  it('creates a portal session with a server-built return_url', async () => {
    const create = jest.fn().mockResolvedValue({
      url: 'https://billing.stripe.com/p/session/test_abc',
    });
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const result = await createBillingPortalSession({
      customerId: 'cus_123',
      stripe: { billingPortal: { sessions: { create } } },
      origin: 'https://preview.example',
      configurationId: 'bpc_1',
      mode: 'test',
      log,
    });

    expect(result).toEqual({ url: 'https://billing.stripe.com/p/session/test_abc' });
    expect(create).toHaveBeenCalledWith({
      customer: 'cus_123',
      return_url: portalReturnUrl('https://preview.example'),
      configuration: 'bpc_1',
    });
    const serialized = JSON.stringify(log.info.mock.calls);
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain('sk_test_');
  });
});
