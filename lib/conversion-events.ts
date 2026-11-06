import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

/**
 * Isolated WARDROBE-249 Meta Conversions API + TikTok Events API secrets.
 *
 * CDK creates placeholders only. Operators replace the JSON in Secrets
 * Manager per stage after deploy. Never commit real tokens.
 *
 * Webhook Lambdas are 20s. Conversion send is capped at 4s wall-clock
 * (2 attempts × 1.5s HTTP timeout + 100ms backoff, platforms in parallel)
 * so entitlement handling still has headroom.
 */
export const CONVERSION_WEBHOOK_LAMBDA_TIMEOUT_SECONDS = 20;
export interface ConversionEventSecretsProps {
  stage: string;
  removalPolicy: cdk.RemovalPolicy;
}

export interface ConversionEventSecrets {
  metaCapiSecret: secretsmanager.Secret;
  tiktokEventsSecret: secretsmanager.Secret;
}

export function metaCapiSecretName(stage: string): string {
  return `wardrobe/${stage}/meta-capi`;
}

export function tiktokEventsSecretName(stage: string): string {
  return `wardrobe/${stage}/tiktok-events`;
}

export function addConversionEventSecrets(
  scope: Construct,
  props: ConversionEventSecretsProps,
): ConversionEventSecrets {
  const { stage, removalPolicy } = props;

  const metaCapiSecret = new secretsmanager.Secret(scope, 'MetaCapiSecret', {
    secretName: metaCapiSecretName(stage),
    description:
      'Meta Conversions API credentials (WARDROBE-249). Store JSON { "pixelId", "accessToken", "testEventCode"? }. Replace the generated placeholder after deploy. Never commit the real token. Leave the placeholder to skip sending.',
    removalPolicy,
  });

  const tiktokEventsSecret = new secretsmanager.Secret(
    scope,
    'TiktokEventsSecret',
    {
      secretName: tiktokEventsSecretName(stage),
      description:
        'TikTok Events API credentials (WARDROBE-249). Store JSON { "pixelCode", "accessToken", "testEventCode"? }. Replace the generated placeholder after deploy. Never commit the real token. Leave the placeholder to skip sending.',
      removalPolicy,
    },
  );

  new cdk.CfnOutput(scope, 'MetaCapiSecretName', {
    value: metaCapiSecret.secretName,
    description:
      'Secrets Manager secret for Meta Conversions API { pixelId, accessToken, testEventCode? } (placeholder until replaced)',
  });

  new cdk.CfnOutput(scope, 'TiktokEventsSecretName', {
    value: tiktokEventsSecret.secretName,
    description:
      'Secrets Manager secret for TikTok Events API { pixelCode, accessToken, testEventCode? } (placeholder until replaced)',
  });

  return { metaCapiSecret, tiktokEventsSecret };
}

/**
 * Least-privilege read of Meta + TikTok conversion secrets for the
 * Stripe and Superwall webhook Lambdas only.
 */
export function grantConversionEventSecretRead(
  fn: lambda.Function,
  secrets: ConversionEventSecrets,
): void {
  secrets.metaCapiSecret.grantRead(fn);
  secrets.tiktokEventsSecret.grantRead(fn);
  fn.addEnvironment('META_CAPI_SECRET_ARN', secrets.metaCapiSecret.secretArn);
  fn.addEnvironment(
    'TIKTOK_EVENTS_SECRET_ARN',
    secrets.tiktokEventsSecret.secretArn,
  );
}
