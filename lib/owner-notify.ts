import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import * as path from 'path';
import {
  OWNER_NOTIFY_QUEUE_URL_ENV,
  OWNER_NOTIFY_RECIPIENT_PARAM_ENV,
  OWNER_NOTIFY_RESEND_SECRET_ARN_ENV,
  OWNER_NOTIFY_SENDER_PARAM_ENV,
  ownerNotifyRecipientParamName,
  ownerNotifyResendSecretName,
  ownerNotifySenderParamName,
} from '../src/shared/owner-notify-names';

/**
 * Isolated WARDROBE-273 wiring (owner subscription emails via Resend).
 *
 * Webhook Lambdas enqueue to SQS. A dedicated notifier reads SSM (or env)
 * for the sender / recipient, reads the Resend API key from Secrets Manager,
 * dedupes in Dynamo, and POSTs to Resend. Addresses and the API key are
 * never hardcoded.
 */
export const OWNER_NOTIFY_LAMBDA_TIMEOUT_SECONDS = 15;
export const OWNER_NOTIFY_MAX_RECEIVE_COUNT = 3;

export interface OwnerNotifyProps {
  stage: string;
  table: dynamodb.ITable;
  stripeWebhookFn: NodejsFunction;
  entitlementsWebhookFn: NodejsFunction;
  commonLambdaProps: Partial<NodejsFunctionProps>;
  removalPolicy: cdk.RemovalPolicy;
}

export interface OwnerNotifyResources {
  queue: sqs.Queue;
  dlq: sqs.Queue;
  fn: NodejsFunction;
  resendSecret: secretsmanager.Secret;
  recipientParamName: string;
  senderParamName: string;
  resendSecretName: string;
}

export function addOwnerNotify(
  scope: Construct,
  props: OwnerNotifyProps,
): OwnerNotifyResources {
  const {
    stage,
    table,
    stripeWebhookFn,
    entitlementsWebhookFn,
    commonLambdaProps,
    removalPolicy,
  } = props;

  const recipientParamName = ownerNotifyRecipientParamName(stage);
  const senderParamName = ownerNotifySenderParamName(stage);
  const resendSecretName = ownerNotifyResendSecretName(stage);
  const timeout = cdk.Duration.seconds(OWNER_NOTIFY_LAMBDA_TIMEOUT_SECONDS);
  const visibilityTimeout = cdk.Duration.seconds(timeout.toSeconds() * 2);

  const dlq = new sqs.Queue(scope, 'OwnerNotifyDlq', {
    queueName: `wardrobe-owner-notify-dlq-${stage}`,
    visibilityTimeout,
    retentionPeriod: cdk.Duration.days(14),
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy,
  });

  const queue = new sqs.Queue(scope, 'OwnerNotifyQueue', {
    queueName: `wardrobe-owner-notify-${stage}`,
    visibilityTimeout,
    retentionPeriod: cdk.Duration.days(4),
    receiveMessageWaitTime: cdk.Duration.seconds(20),
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    removalPolicy,
    deadLetterQueue: {
      queue: dlq,
      maxReceiveCount: OWNER_NOTIFY_MAX_RECEIVE_COUNT,
    },
  });

  const resendSecret = new secretsmanager.Secret(scope, 'OwnerNotifyResendSecret', {
    secretName: resendSecretName,
    description:
      'Resend API key for owner subscription emails (WARDROBE-273). Replace the placeholder. Never commit the real key.',
    removalPolicy,
  });

  const logGroup = new logs.LogGroup(scope, 'OwnerNotifyFnLogs', {
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const fn = new NodejsFunction(scope, 'OwnerNotifyFn', {
    ...commonLambdaProps,
    timeout,
    environment: {
      ...commonLambdaProps.environment,
      [OWNER_NOTIFY_QUEUE_URL_ENV]: queue.queueUrl,
      [OWNER_NOTIFY_RECIPIENT_PARAM_ENV]: recipientParamName,
      [OWNER_NOTIFY_SENDER_PARAM_ENV]: senderParamName,
      [OWNER_NOTIFY_RESEND_SECRET_ARN_ENV]: resendSecret.secretArn,
    },
    entry: path.join(__dirname, '../src/functions/owner-notify/handler.ts'),
    handler: 'handler',
    logGroup,
  });

  fn.addEventSource(
    new SqsEventSource(queue, {
      batchSize: 1,
      reportBatchItemFailures: true,
    }),
  );

  fn.addToRolePolicy(
    new iam.PolicyStatement({
      sid: 'OwnerNotifyDedupe',
      actions: ['dynamodb:PutItem', 'dynamodb:DeleteItem'],
      resources: [table.tableArn],
      conditions: {
        'ForAllValues:StringLike': {
          'dynamodb:LeadingKeys': ['NOTIFY#*'],
        },
      },
    }),
  );

  const parameterArns = [
    parameterArn(scope, recipientParamName),
    parameterArn(scope, senderParamName),
  ];
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      sid: 'OwnerNotifySsmRead',
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: parameterArns,
    }),
  );

  resendSecret.grantRead(fn);

  queue.grantSendMessages(stripeWebhookFn);
  queue.grantSendMessages(entitlementsWebhookFn);
  stripeWebhookFn.addEnvironment(OWNER_NOTIFY_QUEUE_URL_ENV, queue.queueUrl);
  entitlementsWebhookFn.addEnvironment(OWNER_NOTIFY_QUEUE_URL_ENV, queue.queueUrl);

  new cdk.CfnOutput(scope, 'OwnerNotifyQueueUrl', {
    value: queue.queueUrl,
    description:
      'SQS queue for owner subscription emails (WARDROBE-273). Stripe and Superwall webhooks enqueue here.',
  });
  new cdk.CfnOutput(scope, 'OwnerNotifyRecipientParamName', {
    value: recipientParamName,
    description:
      'SSM parameter name for the owner-notify recipient address. Values are never stored in CDK.',
  });
  new cdk.CfnOutput(scope, 'OwnerNotifySenderParamName', {
    value: senderParamName,
    description:
      'SSM parameter name for the owner-notify From address. Values are never stored in CDK.',
  });
  new cdk.CfnOutput(scope, 'OwnerNotifyResendSecretName', {
    value: resendSecretName,
    description:
      'Secrets Manager name for the owner-notify Resend API key. Replace the placeholder; never put the key in source.',
  });

  return {
    queue,
    dlq,
    fn,
    resendSecret,
    recipientParamName,
    senderParamName,
    resendSecretName,
  };
}

function parameterArn(scope: Construct, name: string): string {
  const stack = cdk.Stack.of(scope);
  const trimmed = name.startsWith('/') ? name.slice(1) : name;
  return `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter/${trimmed}`;
}
