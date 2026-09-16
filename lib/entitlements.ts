import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * Isolated WARDROBE-91 wiring (Superwall webhook → Dynamo entitlements).
 * GET /me stays on MeFn. This module only owns the public webhook + secret.
 */
export interface EntitlementsProps {
  stage: string;
  httpApi: apigwv2.HttpApi;
  table: dynamodb.ITable;
  commonLambdaProps: Partial<NodejsFunctionProps>;
  removalPolicy: cdk.RemovalPolicy;
}

export interface EntitlementsResources {
  superwallSecret: secretsmanager.Secret;
  webhookFn: NodejsFunction;
}

export function addEntitlements(
  scope: Construct,
  props: EntitlementsProps,
): EntitlementsResources {
  const { stage, httpApi, table, commonLambdaProps, removalPolicy } = props;

  const superwallSecret = new secretsmanager.Secret(scope, 'SuperwallSecret', {
    secretName: `wardrobe/${stage}/superwall`,
    description:
      'Superwall webhook signing secret (WARDROBE-91). Store JSON { "webhookSecret", "productTiers"? }. productTiers maps App Store / Play product IDs (TBD) to BASIC | PREMIUM. Never commit the real secret.',
    removalPolicy,
  });

  const logGroup = new logs.LogGroup(scope, 'EntitlementsWebhookFnLogs', {
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const webhookFn = new NodejsFunction(scope, 'EntitlementsWebhookFn', {
    ...commonLambdaProps,
    timeout: cdk.Duration.seconds(15),
    environment: {
      ...commonLambdaProps.environment,
      SUPERWALL_SECRET_ARN: superwallSecret.secretArn,
    },
    entry: path.join(
      __dirname,
      '../src/functions/entitlements-webhook/handler.ts',
    ),
    handler: 'handler',
    logGroup,
  });

  superwallSecret.grantRead(webhookFn);
  table.grantReadWriteData(webhookFn);

  const webhookIntegration = new HttpLambdaIntegration(
    'EntitlementsWebhookIntegration',
    webhookFn,
  );

  httpApi.addRoutes({
    path: '/webhooks/superwall',
    methods: [apigwv2.HttpMethod.POST],
    integration: webhookIntegration,
  });

  new cdk.CfnOutput(scope, 'SuperwallSecretName', {
    value: superwallSecret.secretName,
    description:
      'Secrets Manager secret for Superwall webhook signing secret + optional productTiers map (placeholder until replaced)',
  });

  new cdk.CfnOutput(scope, 'SuperwallWebhookUrl', {
    value: `${httpApi.apiEndpoint}/webhooks/superwall`,
    description:
      'Public Superwall subscription webhook URL (no Firebase auth; Svix-signed)',
  });

  return { superwallSecret, webhookFn };
}
