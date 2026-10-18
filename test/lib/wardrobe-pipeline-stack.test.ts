import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AppConfig } from '../../lib/config';
import { WardrobePipelineStack } from '../../lib/wardrobe-pipeline-stack';

jest.setTimeout(180_000);

const pipelineSource: AppConfig = {
  stage: 'prod',
  githubOwner: 'acme',
  githubRepo: 'wardrobe-backend',
  githubBranch: 'main',
  connectionArn:
    'arn:aws:codeconnections:eu-west-1:123456789012:connection/abc',
};

function synthPipeline(config: AppConfig): Template {
  const app = new cdk.App();
  const stack = new WardrobePipelineStack(app, 'WardrobePipeline', { config });
  return Template.fromStack(stack);
}

function codeBuildEnvMaps(template: Template): Array<Record<string, string>> {
  const projects = template.findResources('AWS::CodeBuild::Project');
  return Object.values(projects).map((resource) => {
    const vars =
      (
        resource as {
          Properties?: {
            Environment?: {
              EnvironmentVariables?: Array<{ Name?: string; Value?: string }>;
            };
          };
        }
      ).Properties?.Environment?.EnvironmentVariables ?? [];
    const map: Record<string, string> = {};
    for (const entry of vars) {
      if (entry.Name && entry.Value !== undefined) {
        map[entry.Name] = entry.Value;
      }
    }
    return map;
  });
}

function synthBuildSpec(template: Template): string {
  const projects = Object.values(
    template.findResources('AWS::CodeBuild::Project'),
  ) as Array<{
    Properties?: { Source?: { BuildSpec?: string } };
  }>;
  const spec = projects
    .map((project) => project.Properties?.Source?.BuildSpec)
    .find((value) => value && value.includes('cdk synth'));
  if (!spec) {
    throw new Error('Synth CodeBuild buildspec not found');
  }
  return spec;
}

function synthStepEnv(template: Template): Record<string, string> {
  const env = codeBuildEnvMaps(template).find(
    (vars) =>
      vars.CI === 'true' &&
      vars.STAGE === 'prod' &&
      vars.GITHUB_OWNER === pipelineSource.githubOwner,
  );
  if (!env) {
    throw new Error('Synth CodeBuild project env not found');
  }
  return env;
}

describe('WardrobePipelineStack support-contact synth env (WARDROBE-144)', () => {
  test('bakes non-empty support-contact settings into the Synth project', () => {
    const template = synthPipeline({
      ...pipelineSource,
      supportContactAllowedOrigins:
        'https://a.example,https://*--b.netlify.app',
      supportContactRateLimit: '8',
      supportContactRateWindowSeconds: '1200',
    });

    const env = synthStepEnv(template);
    expect(env.SUPPORT_CONTACT_ALLOWED_ORIGINS).toBe(
      'https://a.example,https://*--b.netlify.app',
    );
    expect(env.SUPPORT_CONTACT_RATE_LIMIT).toBe('8');
    expect(env.SUPPORT_CONTACT_RATE_WINDOW_SECONDS).toBe('1200');
  });

  test('omits support-contact env vars when config does not set them', () => {
    const template = synthPipeline(pipelineSource);
    const env = synthStepEnv(template);

    expect(env).not.toHaveProperty('SUPPORT_CONTACT_ALLOWED_ORIGINS');
    expect(env).not.toHaveProperty('SUPPORT_CONTACT_RATE_LIMIT');
    expect(env).not.toHaveProperty('SUPPORT_CONTACT_RATE_WINDOW_SECONDS');

    for (const vars of codeBuildEnvMaps(template)) {
      expect(vars).not.toHaveProperty('SUPPORT_CONTACT_ALLOWED_ORIGINS');
      expect(vars).not.toHaveProperty('SUPPORT_CONTACT_RATE_LIMIT');
      expect(vars).not.toHaveProperty('SUPPORT_CONTACT_RATE_WINDOW_SECONDS');
    }
  });
});

describe('WardrobePipelineStack upload CORS synth env (WARDROBE-176)', () => {
  test('bakes non-empty uploadAllowedOrigins into the Synth project', () => {
    const template = synthPipeline({
      ...pipelineSource,
      uploadAllowedOrigins:
        'https://wende-wardrobe.netlify.app,http://localhost:5173',
    });

    const env = synthStepEnv(template);
    expect(env.UPLOAD_ALLOWED_ORIGINS).toBe(
      'https://wende-wardrobe.netlify.app,http://localhost:5173',
    );
  });

  test('omits UPLOAD_ALLOWED_ORIGINS when config does not set it', () => {
    const template = synthPipeline(pipelineSource);
    const env = synthStepEnv(template);

    expect(env).not.toHaveProperty('UPLOAD_ALLOWED_ORIGINS');
    for (const vars of codeBuildEnvMaps(template)) {
      expect(vars).not.toHaveProperty('UPLOAD_ALLOWED_ORIGINS');
    }
  });
});

describe('WardrobePipelineStack Stripe synth env (WARDROBE-187)', () => {
  test('bakes non-empty Stripe mode and lookup keys into the Synth project', () => {
    const template = synthPipeline({
      ...pipelineSource,
      stripeMode: 'test',
      stripeLookupKeyBasicMonthly: 'wardrobe_basic_monthly',
      stripeLookupKeyPremiumMonthly: 'wardrobe_premium_monthly',
      stripeLookupKeyBasicYearly: 'wardrobe_basic_yearly',
      stripeLookupKeyPremiumYearly: 'wardrobe_premium_yearly',
    });

    const env = synthStepEnv(template);
    expect(env.STRIPE_MODE).toBe('test');
    expect(env.STRIPE_LOOKUP_KEY_BASIC_MONTHLY).toBe('wardrobe_basic_monthly');
    expect(env.STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY).toBe(
      'wardrobe_premium_monthly',
    );
    expect(env.STRIPE_LOOKUP_KEY_BASIC_YEARLY).toBe('wardrobe_basic_yearly');
    expect(env.STRIPE_LOOKUP_KEY_PREMIUM_YEARLY).toBe(
      'wardrobe_premium_yearly',
    );
  });

  test('bakes a non-empty billingWebOrigin into the Synth project', () => {
    const template = synthPipeline({
      ...pipelineSource,
      billingWebOrigin: 'https://preview.example',
    });

    const env = synthStepEnv(template);
    expect(env.BILLING_WEB_ORIGIN).toBe('https://preview.example');
    const spec = synthBuildSpec(template);
    expect(spec).toMatch(/-c billingWebOrigin=/);
    expect(spec).toContain('https://preview.example');
  });

  test('bakes a non-empty stripePortalConfigurationId into the Synth project', () => {
    const template = synthPipeline({
      ...pipelineSource,
      stripePortalConfigurationId: 'bpc_pipeline',
    });

    const env = synthStepEnv(template);
    expect(env.STRIPE_PORTAL_CONFIGURATION_ID).toBe('bpc_pipeline');
  });

  test('does not bake leftover OUTFIT_SUGGESTION_CAP into the Synth project', () => {
    const template = synthPipeline({
      ...pipelineSource,
      // Leftover keys must be ignored even if a caller still passes them.
      ...({
        outfitSuggestionCap: '8',
        outfitSuggestionCapBasic: '2',
      } as unknown as AppConfig),
    });

    const env = synthStepEnv(template);
    expect(env).not.toHaveProperty('OUTFIT_SUGGESTION_CAP');
    expect(env).not.toHaveProperty('OUTFIT_SUGGESTION_CAP_BASIC');
  });

  test('omits Stripe synth env vars when config does not set them', () => {
    const template = synthPipeline(pipelineSource);
    const env = synthStepEnv(template);

    expect(env).not.toHaveProperty('STRIPE_MODE');
    expect(env).not.toHaveProperty('STRIPE_LOOKUP_KEY_BASIC_MONTHLY');
    expect(env).not.toHaveProperty('STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY');
    expect(env).not.toHaveProperty('BILLING_WEB_ORIGIN');
    expect(env).not.toHaveProperty('STRIPE_PORTAL_CONFIGURATION_ID');
    expect(env).not.toHaveProperty('OUTFIT_SUGGESTION_CAP');
    expect(env).not.toHaveProperty('OUTFIT_SUGGESTION_CAP_BASIC');
    for (const vars of codeBuildEnvMaps(template)) {
      expect(vars).not.toHaveProperty('STRIPE_MODE');
      expect(vars).not.toHaveProperty('STRIPE_LOOKUP_KEY_BASIC_MONTHLY');
      expect(vars).not.toHaveProperty('STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY');
      expect(vars).not.toHaveProperty('BILLING_WEB_ORIGIN');
      expect(vars).not.toHaveProperty('STRIPE_PORTAL_CONFIGURATION_ID');
      expect(vars).not.toHaveProperty('OUTFIT_SUGGESTION_CAP');
      expect(vars).not.toHaveProperty('OUTFIT_SUGGESTION_CAP_BASIC');
    }
  });
});
