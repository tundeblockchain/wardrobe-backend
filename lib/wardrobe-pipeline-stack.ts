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

    const synth = new CodeBuildStep('Synth', {
      input: source,
      commands: [
        'npm ci',
        'node scripts/ensure-cdk-json.js',
        `npx cdk synth --app "${CDK_APP}"`,
      ],
      env: {
        CI: 'true',
        STAGE: 'prod',
        FIREBASE_PROJECT_ID: config.firebaseProjectId,
        GITHUB_OWNER: config.githubOwner,
        GITHUB_REPO: config.githubRepo,
        GITHUB_BRANCH: config.githubBranch,
        CODESTAR_CONNECTION_ARN: config.connectionArn,
      },
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
        firebaseProjectId: config.firebaseProjectId,
      }),
    );
  }
}
