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
