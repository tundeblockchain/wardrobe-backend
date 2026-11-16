import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import {
  OWNER_NOTIFY_RECIPIENT_PARAM_ENV,
  ownerNotifyRecipientParamName,
  RESEND_SECRET_ARN_ENV,
  SUPPORT_FROM_EMAIL_ENV,
} from '../src/shared/owner-notify-names';

/**
 * Isolated WARDROBE-273 wiring (owner subscription emails via Resend).
 *
 * Stripe and Superwall webhook Lambdas send inline through the shared
 * WARDROBE-38 Resend helper. The only new config is the recipient SSM
 * parameter; sender is the existing support-mail `fromEmail`.
 */
export interface OwnerNotifyProps {
  stage: string;
  stripeWebhookFn: NodejsFunction;
  entitlementsWebhookFn: NodejsFunction;
  resendSecret: secretsmanager.ISecret;
  supportMailSecret: secretsmanager.ISecret;
}

export function addOwnerNotify(scope: Construct, props: OwnerNotifyProps): void {
  const {
    stage,
    stripeWebhookFn,
    entitlementsWebhookFn,
    resendSecret,
    supportMailSecret,
  } = props;

  const recipientParamName = ownerNotifyRecipientParamName(stage);
  const recipientParamArn = cdk.Stack.of(scope).formatArn({
    service: 'ssm',
    resource: 'parameter',
    resourceName: recipientParamName.replace(/^\//, ''),
  });
  const fromEmail = supportMailSecret
    .secretValueFromJson('fromEmail')
    .unsafeUnwrap();

  for (const fn of [stripeWebhookFn, entitlementsWebhookFn]) {
    fn.addEnvironment(RESEND_SECRET_ARN_ENV, resendSecret.secretArn);
    fn.addEnvironment(OWNER_NOTIFY_RECIPIENT_PARAM_ENV, recipientParamName);
    fn.addEnvironment(SUPPORT_FROM_EMAIL_ENV, fromEmail);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'OwnerNotifyExistingSecretRead',
        actions: ['secretsmanager:GetSecretValue'],
        resources: [resendSecret.secretArn],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'OwnerNotifyRecipientRead',
        actions: ['ssm:GetParameter'],
        resources: [recipientParamArn],
      }),
    );
  }

  new cdk.CfnOutput(scope, 'OwnerNotifyRecipientParamName', {
    value: recipientParamName,
    description:
      'SSM parameter for the owner-notify recipient. The operator sets its value.',
  });
}
