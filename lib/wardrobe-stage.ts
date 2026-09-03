import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { WardrobeStack } from './wardrobe-stack';

export interface WardrobeStageProps extends cdk.StageProps {
  stage: string;
  firebaseProjectId: string;
}

export class WardrobeStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: WardrobeStageProps) {
    super(scope, id, props);

    new WardrobeStack(this, 'App', {
      stackName: `WardrobeStack-${props.stage}`,
      env: props.env,
      description: `Digital Wardrobe backend (${props.stage})`,
      stage: props.stage,
      firebaseProjectId: props.firebaseProjectId,
    });
  }
}
