import {
  assertStripeKeyMatchesMode,
  getStripeClient,
  getStripeConfig,
  parseStripeMode,
  parseStripeSecret,
  resetStripeCaches,
  resolveStripeMode,
  stripeSecretName,
} from '../../src/shared/stripe-config';

describe('stripe mode selection (WARDROBE-187)', () => {
  it('defaults to test when requested mode is unset', () => {
    expect(resolveStripeMode('dev')).toBe('test');
    expect(resolveStripeMode('prod')).toBe('test');
    expect(parseStripeMode(undefined)).toBeUndefined();
    expect(parseStripeMode('LIVE')).toBe('live');
  });

  it('allows live only on prod / production', () => {
    expect(resolveStripeMode('prod', 'live')).toBe('live');
    expect(resolveStripeMode('production', 'live')).toBe('live');
  });

  it('rejects live for preview and dev stages', () => {
    expect(() => resolveStripeMode('dev', 'live')).toThrow(
      /Stripe live mode is not allowed for stage "dev"/,
    );
    expect(() => resolveStripeMode('preview-123', 'live')).toThrow(
      /Stripe live mode is not allowed/,
    );
    expect(() => resolveStripeMode('staging', 'live')).toThrow(
      /Stripe live mode is not allowed/,
    );
  });

  it('names secrets per stage and mode', () => {
    expect(stripeSecretName('dev', 'test')).toBe('wardrobe/dev/stripe-test');
    expect(stripeSecretName('prod', 'live')).toBe('wardrobe/prod/stripe-live');
  });
});

describe('parseStripeSecret', () => {
  it('parses JSON secretKey and webhookSecret', () => {
    expect(
      parseStripeSecret(
        JSON.stringify({
          secretKey: 'sk_test_abc',
          webhookSecret: 'whsec_xyz',
        }),
      ),
    ).toEqual({ secretKey: 'sk_test_abc', webhookSecret: 'whsec_xyz' });
  });

  it('accepts a raw secret key string', () => {
    expect(parseStripeSecret('  sk_test_plain  ')).toEqual({
      secretKey: 'sk_test_plain',
      webhookSecret: '',
    });
  });

  it('throws when JSON is missing secretKey', () => {
    expect(() =>
      parseStripeSecret(JSON.stringify({ webhookSecret: 'whsec_only' })),
    ).toThrow('Stripe secret is missing secretKey.');
  });
});

describe('getStripeConfig', () => {
  const secretKey = 'sk_test_DO_NOT_LOG_THIS_VALUE_9f3a';
  const webhookSecret = 'whsec_DO_NOT_LOG_THIS_EITHER_4c2b';

  beforeEach(() => {
    resetStripeCaches();
  });

  afterEach(() => {
    resetStripeCaches();
  });

  it('loads the secret, selects test mode, and caches the result', async () => {
    const getSecretString = jest.fn().mockResolvedValue(
      JSON.stringify({ secretKey, webhookSecret }),
    );
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const env = {
      STRIPE_SECRET_ARN: 'arn:aws:secretsmanager:eu-west-1:1:secret:stripe-test',
      STRIPE_MODE: 'test',
      STAGE: 'dev',
    };

    const first = await getStripeConfig({ env, getSecretString, log });
    const second = await getStripeConfig({ env, getSecretString, log });

    expect(first.mode).toBe('test');
    expect(first.secretKey).toBe(secretKey);
    expect(first.webhookSecret).toBe(webhookSecret);
    expect(first.lookupKeys.basicMonthly).toBe('wardrobe_basic_monthly');
    expect(first.lookupKeys.premiumMonthly).toBe('wardrobe_premium_monthly');
    expect(second).toBe(first);
    expect(getSecretString).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error when STRIPE_SECRET_ARN is missing', async () => {
    const getSecretString = jest.fn();
    await expect(
      getStripeConfig({ env: { STAGE: 'dev' }, getSecretString }),
    ).rejects.toThrow('STRIPE_SECRET_ARN is not set.');
    expect(getSecretString).not.toHaveBeenCalled();
  });

  it('throws when the stored secret is a placeholder', async () => {
    await expect(
      getStripeConfig({
        env: { STRIPE_SECRET_ARN: 'arn:secret', STAGE: 'dev' },
        getSecretString: async () =>
          JSON.stringify({
            secretKey: 'sk_test_placeholder',
            webhookSecret: 'whsec_placeholder',
          }),
      }),
    ).rejects.toThrow(/placeholder/);
  });

  it('never logs the secret key or webhook signing secret', async () => {
    const getSecretString = jest.fn().mockResolvedValue(
      JSON.stringify({ secretKey, webhookSecret }),
    );
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    await getStripeConfig({
      env: {
        STRIPE_SECRET_ARN: 'arn:aws:secretsmanager:eu-west-1:1:secret:stripe-test',
        STRIPE_MODE: 'test',
        STAGE: 'dev',
      },
      getSecretString,
      log,
    });

    const serialized = JSON.stringify({
      info: log.info.mock.calls,
      warn: log.warn.mock.calls,
      error: log.error.mock.calls,
    });
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain(webhookSecret);
    expect(serialized).not.toContain('sk_test_');
    expect(serialized).not.toContain('whsec_');
    expect(log.info).toHaveBeenCalledWith(
      'Stripe config loaded',
      expect.objectContaining({ mode: 'test' }),
    );
  });

  it('does not include secret values in mode-mismatch errors', () => {
    const liveKey = 'sk_live_SHOULD_NOT_APPEAR_IN_ERROR';
    expect(() => assertStripeKeyMatchesMode('test', liveKey)).toThrow(
      'Stripe test mode cannot use a live secret key.',
    );
    try {
      assertStripeKeyMatchesMode('test', liveKey);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(liveKey);
      expect((error as Error).message).not.toContain('sk_live_SHOULD');
    }
  });
});

describe('getStripeClient', () => {
  beforeEach(() => {
    resetStripeCaches();
  });

  afterEach(() => {
    resetStripeCaches();
  });

  it('caches the Stripe client for the same secret ARN', async () => {
    const getSecretString = jest.fn().mockResolvedValue(
      JSON.stringify({
        secretKey: 'sk_test_cached_client_key',
        webhookSecret: 'whsec_cached',
      }),
    );
    const env = {
      STRIPE_SECRET_ARN: 'arn:secret:stripe-test',
      STRIPE_MODE: 'test',
      STAGE: 'dev',
    };
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const first = await getStripeClient({ env, getSecretString, log });
    const second = await getStripeClient({ env, getSecretString, log });

    expect(second).toBe(first);
    expect(getSecretString).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(
      'sk_test_cached_client_key',
    );
  });
});
