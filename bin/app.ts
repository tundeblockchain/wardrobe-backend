#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { applyCdkFeatureFlags } from '../lib/cdk-context';
import { hasPipelineSource, isCiEnvironment, resolveAppConfig } from '../lib/config';
import { WardrobePipelineStack } from '../lib/wardrobe-pipeline-stack';
import { WardrobeStack } from '../lib/wardrobe-stack';

const app = new cdk.App();
applyCdkFeatureFlags(app);

const config = resolveAppConfig(app.node);
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};
const isCi = isCiEnvironment();

if (hasPipelineSource(config)) {
  new WardrobePipelineStack(app, 'WardrobePipeline', {
    env,
    config,
    description: 'Digital Wardrobe CI/CD pipeline',
  });
} else if (isCi) {
  throw new Error(
    'Pipeline synth is missing GITHUB_OWNER, GITHUB_REPO, or CODESTAR_CONNECTION_ARN.',
  );
}

if (!isCi) {
  new WardrobeStack(app, `WardrobeStack-${config.stage}`, {
    env,
    stage: config.stage,
    description: `Digital Wardrobe backend (${config.stage})`,
  });
}
