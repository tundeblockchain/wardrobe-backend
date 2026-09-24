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
