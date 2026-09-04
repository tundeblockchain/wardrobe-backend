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
