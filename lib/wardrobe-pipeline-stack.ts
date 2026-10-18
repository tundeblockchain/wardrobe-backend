import * as cdk from 'aws-cdk-lib';
import { BuildSpec, LinuxBuildImage } from 'aws-cdk-lib/aws-codebuild';
import {
  CodeBuildStep,
  CodePipeline,
  CodePipelineSource,
} from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import { AppConfig } from './config';
import { WardrobeStage } from './wardrobe-stage';

export interface WardrobePipelineStackProps extends cdk.StackProps {
  config: AppConfig;
}

const CDK_APP = 'node -r ts-node/register/transpile-only bin/app.ts';

export class WardrobePipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WardrobePipelineStackProps) {
    super(scope, id, props);

    const { config } = props;
    if (!config.githubOwner || !config.githubRepo || !config.connectionArn) {
      throw new Error(
        'Pipeline requires githubOwner, githubRepo, and connectionArn.',
      );
    }

    const source = CodePipelineSource.connection(
      `${config.githubOwner}/${config.githubRepo}`,
      config.githubBranch,
      {
        connectionArn: config.connectionArn,
      },
    );

    const synthEnv: Record<string, string> = {
      CI: 'true',
      STAGE: 'prod',
      GITHUB_OWNER: config.githubOwner,
      GITHUB_REPO: config.githubRepo,
      GITHUB_BRANCH: config.githubBranch,
      CODESTAR_CONNECTION_ARN: config.connectionArn,
    };
    if (config.supportContactAllowedOrigins) {
      synthEnv.SUPPORT_CONTACT_ALLOWED_ORIGINS =
        config.supportContactAllowedOrigins;
    }
    if (config.supportContactRateLimit) {
      synthEnv.SUPPORT_CONTACT_RATE_LIMIT = config.supportContactRateLimit;
    }
    if (config.supportContactRateWindowSeconds) {
      synthEnv.SUPPORT_CONTACT_RATE_WINDOW_SECONDS =
        config.supportContactRateWindowSeconds;
    }
    if (config.uploadAllowedOrigins) {
      synthEnv.UPLOAD_ALLOWED_ORIGINS = config.uploadAllowedOrigins;
    }
    if (config.stripeMode) {
      synthEnv.STRIPE_MODE = config.stripeMode;
    }
    if (config.stripeLookupKeyBasicMonthly) {
      synthEnv.STRIPE_LOOKUP_KEY_BASIC_MONTHLY =
        config.stripeLookupKeyBasicMonthly;
    }
    if (config.stripeLookupKeyPremiumMonthly) {
      synthEnv.STRIPE_LOOKUP_KEY_PREMIUM_MONTHLY =
        config.stripeLookupKeyPremiumMonthly;
    }
    if (config.stripeLookupKeyBasicYearly) {
      synthEnv.STRIPE_LOOKUP_KEY_BASIC_YEARLY = config.stripeLookupKeyBasicYearly;
    }
    if (config.stripeLookupKeyPremiumYearly) {
      synthEnv.STRIPE_LOOKUP_KEY_PREMIUM_YEARLY =
        config.stripeLookupKeyPremiumYearly;
    }
    const synthContextFlags: string[] = [];
    if (config.billingWebOrigin) {
      synthEnv.BILLING_WEB_ORIGIN = config.billingWebOrigin;
      synthContextFlags.push(
        `-c billingWebOrigin="${config.billingWebOrigin}"`,
      );
    }
    if (config.stripePortalConfigurationId) {
      synthEnv.STRIPE_PORTAL_CONFIGURATION_ID =
        config.stripePortalConfigurationId;
    }
    if (config.outfitSuggestionCap) {
      synthEnv.OUTFIT_SUGGESTION_CAP = config.outfitSuggestionCap;
    }

    const synthCommand = [
      `npx cdk synth --app "${CDK_APP}"`,
      ...synthContextFlags,
    ].join(' ');

    const synth = new CodeBuildStep('Synth', {
      input: source,
      commands: [
        'npm ci',
        'node scripts/ensure-cdk-json.js',
        synthCommand,
      ],
      env: synthEnv,
      primaryOutputDirectory: 'cdk.out',
    });

    const pipeline = new CodePipeline(this, 'Pipeline', {
      pipelineName: 'wardrobe-backend',
      synth,
      selfMutation: true,
      synthCodeBuildDefaults: {
        buildEnvironment: {
          buildImage: LinuxBuildImage.STANDARD_7_0,
        },
        partialBuildSpec: BuildSpec.fromObject({
          version: '0.2',
          phases: {
            install: {
              'runtime-versions': {
                nodejs: '20',
              },
            },
          },
        }),
      },
    });

    pipeline.addStage(
      new WardrobeStage(this, 'Prod', {
        env: props.env,
        stage: 'prod',
      }),
    );
  }
}
