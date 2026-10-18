import * as fs from 'fs';
import * as path from 'path';
import { hasPipelineSource, isCiEnvironment, resolveAppConfig } from '../../lib/config';

describe('resolveAppConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('defaults stage to dev when context and env are unset', () => {
    delete process.env.STAGE;
    const config = resolveAppConfig({ tryGetContext: () => undefined });
    expect(config.stage).toBe('dev');
  });

  it('prefers CDK context over environment for stage', () => {
    process.env.STAGE = 'staging';
    const config = resolveAppConfig({
      tryGetContext: (key: string) => (key === 'stage' ? 'prod' : undefined),
    });
    expect(config.stage).toBe('prod');
  });

  it('reads stage from STAGE when context is empty', () => {
    process.env.STAGE = 'staging';
    const config = resolveAppConfig({ tryGetContext: () => undefined });
    expect(config.stage).toBe('staging');
  });

  it('prefers CDK context over env for support-contact settings', () => {
    process.env.SUPPORT_CONTACT_ALLOWED_ORIGINS = 'https://env.example';
    process.env.SUPPORT_CONTACT_RATE_LIMIT = '9';
    process.env.SUPPORT_CONTACT_RATE_WINDOW_SECONDS = '120';
    const config = resolveAppConfig({
      tryGetContext: (key: string) => {
        if (key === 'supportContactAllowedOrigins') {
          return 'https://ctx.example,https://*--preview.netlify.app';
        }
        if (key === 'supportContactRateLimit') return '3';
        if (key === 'supportContactRateWindowSeconds') return '90';
        return undefined;
      },
    });
    expect(config.supportContactAllowedOrigins).toBe(
      'https://ctx.example,https://*--preview.netlify.app',
    );
    expect(config.supportContactRateLimit).toBe('3');
    expect(config.supportContactRateWindowSeconds).toBe('90');
  });

  it('reads support-contact settings from env when context is empty', () => {
    process.env.SUPPORT_CONTACT_ALLOWED_ORIGINS =
      'https://env.example,https://*--b.netlify.app';
    process.env.SUPPORT_CONTACT_RATE_LIMIT = '7';
    process.env.SUPPORT_CONTACT_RATE_WINDOW_SECONDS = '1800';
    const config = resolveAppConfig({ tryGetContext: () => undefined });
    expect(config.supportContactAllowedOrigins).toBe(
      'https://env.example,https://*--b.netlify.app',
    );
    expect(config.supportContactRateLimit).toBe('7');
    expect(config.supportContactRateWindowSeconds).toBe('1800');
  });

  it('leaves support-contact settings undefined when context and env are empty', () => {
    delete process.env.SUPPORT_CONTACT_ALLOWED_ORIGINS;
    delete process.env.SUPPORT_CONTACT_RATE_LIMIT;
    delete process.env.SUPPORT_CONTACT_RATE_WINDOW_SECONDS;
    const config = resolveAppConfig({
      tryGetContext: (key: string) => {
        if (key === 'supportContactAllowedOrigins') return '  ';
        if (key === 'supportContactRateLimit') return '';
        if (key === 'supportContactRateWindowSeconds') return undefined;
        return undefined;
      },
    });
    expect(config.supportContactAllowedOrigins).toBeUndefined();
    expect(config.supportContactRateLimit).toBeUndefined();
    expect(config.supportContactRateWindowSeconds).toBeUndefined();
  });

  it('prefers CDK context over env for uploadAllowedOrigins', () => {
    process.env.UPLOAD_ALLOWED_ORIGINS = 'https://env.example';
    const config = resolveAppConfig({
      tryGetContext: (key: string) =>
        key === 'uploadAllowedOrigins'
          ? 'https://ctx.example,https://deploy-preview-*--ctx.netlify.app'
          : undefined,
    });
    expect(config.uploadAllowedOrigins).toBe(
      'https://ctx.example,https://deploy-preview-*--ctx.netlify.app',
    );
  });

  it('reads uploadAllowedOrigins from env when context is empty', () => {
    process.env.UPLOAD_ALLOWED_ORIGINS =
      'https://env.example,http://localhost:5173';
    const config = resolveAppConfig({ tryGetContext: () => undefined });
    expect(config.uploadAllowedOrigins).toBe(
      'https://env.example,http://localhost:5173',
    );
  });

  it('prefers CDK context over env for billingWebOrigin', () => {
    process.env.BILLING_WEB_ORIGIN = 'https://env.example';
    const config = resolveAppConfig({
      tryGetContext: (key: string) =>
        key === 'billingWebOrigin' ? 'https://ctx.example' : undefined,
    });
    expect(config.billingWebOrigin).toBe('https://ctx.example');
  });

  it('reads billingWebOrigin from env when context is empty', () => {
    process.env.BILLING_WEB_ORIGIN = 'https://env.example';
    const config = resolveAppConfig({ tryGetContext: () => undefined });
    expect(config.billingWebOrigin).toBe('https://env.example');
  });

  it('reads billingWebOrigin from committed cdk.json.example context', () => {
    const example = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../cdk.json.example'), 'utf8'),
    ) as { context?: { billingWebOrigin?: string } };
    expect(example.context).toHaveProperty('billingWebOrigin');
  });

  it('leaves billingWebOrigin undefined when context and env are empty', () => {
    delete process.env.BILLING_WEB_ORIGIN;
    const config = resolveAppConfig({
      tryGetContext: (key: string) =>
        key === 'billingWebOrigin' ? '  ' : undefined,
    });
    expect(config.billingWebOrigin).toBeUndefined();
  });

  it('prefers CDK context over env for stripePortalConfigurationId', () => {
    process.env.STRIPE_PORTAL_CONFIGURATION_ID = 'bpc_env';
    const config = resolveAppConfig({
      tryGetContext: (key: string) =>
        key === 'stripePortalConfigurationId' ? 'bpc_ctx' : undefined,
    });
    expect(config.stripePortalConfigurationId).toBe('bpc_ctx');
  });

  it('reads stripePortalConfigurationId from env when context is empty', () => {
    process.env.STRIPE_PORTAL_CONFIGURATION_ID = 'bpc_env';
    const config = resolveAppConfig({ tryGetContext: () => undefined });
    expect(config.stripePortalConfigurationId).toBe('bpc_env');
  });

  it('prefers CDK context over env for the Premium outfit suggestion cap', () => {
    process.env.OUTFIT_SUGGESTION_CAP = '9';
    const config = resolveAppConfig({
      tryGetContext: (key: string) =>
        key === 'outfitSuggestionCap' ? '8' : undefined,
    });
    expect(config.outfitSuggestionCap).toBe('8');
    expect(config).not.toHaveProperty('outfitSuggestionCapBasic');
  });

  it('reads the Premium outfit suggestion cap from env when context is empty', () => {
    process.env.OUTFIT_SUGGESTION_CAP = '8';
    const config = resolveAppConfig({ tryGetContext: () => undefined });
    expect(config.outfitSuggestionCap).toBe('8');
    expect(config).not.toHaveProperty('outfitSuggestionCapBasic');
  });

  it('leaves the Premium outfit suggestion cap undefined when context and env are empty', () => {
    delete process.env.OUTFIT_SUGGESTION_CAP;
    delete process.env.OUTFIT_SUGGESTION_CAP_BASIC;
    const config = resolveAppConfig({
      tryGetContext: (key: string) =>
        key === 'outfitSuggestionCap' || key === 'outfitSuggestionCapBasic'
          ? '  '
          : undefined,
    });
    expect(config.outfitSuggestionCap).toBeUndefined();
    expect(config).not.toHaveProperty('outfitSuggestionCapBasic');
  });

  it('leaves stripePortalConfigurationId undefined when context and env are empty', () => {
    delete process.env.STRIPE_PORTAL_CONFIGURATION_ID;
    const config = resolveAppConfig({
      tryGetContext: (key: string) =>
        key === 'stripePortalConfigurationId' ? '  ' : undefined,
    });
    expect(config.stripePortalConfigurationId).toBeUndefined();
  });

  it('prefers CDK context over env for stripeMode and lookup keys', () => {
    process.env.STRIPE_MODE = 'live';
    process.env.STRIPE_LOOKUP_KEY_BASIC_MONTHLY = 'env_basic';
    process.env.STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY = 'env_premium';
    const config = resolveAppConfig({
      tryGetContext: (key: string) => {
        if (key === 'stripeMode') return 'test';
        if (key === 'stripeLookupKeyBasicMonthly') return 'ctx_basic';
        if (key === 'stripeLookupKeyPremiumMonthly') return 'ctx_premium';
        return undefined;
      },
    });
    expect(config.stripeMode).toBe('test');
    expect(config.stripeLookupKeyBasicMonthly).toBe('ctx_basic');
    expect(config.stripeLookupKeyPremiumMonthly).toBe('ctx_premium');
  });

  it('reads stripe settings from env when context is empty', () => {
    process.env.STRIPE_MODE = 'test';
    process.env.STRIPE_LOOKUP_KEY_BASIC_MONTHLY = 'env_basic';
    process.env.STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY = 'env_premium';
    const config = resolveAppConfig({ tryGetContext: () => undefined });
    expect(config.stripeMode).toBe('test');
    expect(config.stripeLookupKeyBasicMonthly).toBe('env_basic');
    expect(config.stripeLookupKeyPremiumMonthly).toBe('env_premium');
  });

  it('leaves stripe settings undefined when context and env are empty', () => {
    delete process.env.STRIPE_MODE;
    delete process.env.STRIPE_LOOKUP_KEY_BASIC_MONTHLY;
    delete process.env.STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY;
    const config = resolveAppConfig({
      tryGetContext: (key: string) =>
        key === 'stripeMode' ||
        key === 'stripeLookupKeyBasicMonthly' ||
        key === 'stripeLookupKeyPremiumMonthly'
          ? '  '
          : undefined,
    });
    expect(config.stripeMode).toBeUndefined();
    expect(config.stripeLookupKeyBasicMonthly).toBeUndefined();
    expect(config.stripeLookupKeyPremiumMonthly).toBeUndefined();
  });

  it('leaves uploadAllowedOrigins undefined when context and env are empty', () => {
    delete process.env.UPLOAD_ALLOWED_ORIGINS;
    const config = resolveAppConfig({
      tryGetContext: (key: string) =>
        key === 'uploadAllowedOrigins' ? '  ' : undefined,
    });
    expect(config.uploadAllowedOrigins).toBeUndefined();
  });
});

describe('pipeline / CI helpers', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('detects CI from CI or CODEBUILD_BUILD_ID', () => {
    delete process.env.CI;
    delete process.env.CODEBUILD_BUILD_ID;
    expect(isCiEnvironment()).toBe(false);

    process.env.CI = 'true';
    expect(isCiEnvironment()).toBe(true);
  });

  it('requires GitHub owner, repo, and connection ARN for the pipeline', () => {
    expect(
      hasPipelineSource({
        stage: 'dev',
        githubBranch: 'master',
      }),
    ).toBe(false);

    expect(
      hasPipelineSource({
        stage: 'dev',
        githubOwner: 'tundeblockchain',
        githubRepo: 'wardrobe-backend',
        githubBranch: 'master',
        connectionArn: 'arn:aws:codeconnections:eu-west-1:123:connection/abc',
      }),
    ).toBe(true);
  });
});
