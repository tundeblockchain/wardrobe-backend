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
  RESEND_SECRET_ARN_ENV,
  SUPPORT_MAIL_SECRET_ARN_ENV,
} from '../src/shared/owner-notify-names';

/**
 * Isolated WARDROBE-273 wiring (owner subscription emails via Resend).
 *
 * Webhook Lambdas enqueue to SQS. A dedicated notifier reuses the
 * WARDROBE-38 Resend API key and support-mail from/forwardTo secrets,
 * dedupes in Dynamo, and POSTs through the shared Resend helper.
 */
export const OWNER_NOTIFY_LAMBDA_TIMEOUT_SECONDS = 15;
export const OWNER_NOTIFY_MAX_RECEIVE_COUNT = 3;

export interface OwnerNotifyProps {
  stage: string;
  table: dynamodb.ITable;
  stripeWebhookFn: NodejsFunction;
  entitlementsWebhookFn: NodejsFunction;
  resendSecret: secretsmanager.ISecret;
  supportMailSecret: secretsmanager.ISecret;
  commonLambdaProps: Partial<NodejsFunctionProps>;
  removalPolicy: cdk.RemovalPolicy;
}

export interface OwnerNotifyResources {
  queue: sqs.Queue;
  dlq: sqs.Queue;
  fn: NodejsFunction;
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
    resendSecret,
    supportMailSecret,
    commonLambdaProps,
    removalPolicy,
  } = props;

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
      [RESEND_SECRET_ARN_ENV]: resendSecret.secretArn,
      [SUPPORT_MAIL_SECRET_ARN_ENV]: supportMailSecret.secretArn,
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

  fn.addToRolePolicy(
    new iam.PolicyStatement({
      sid: 'OwnerNotifyExistingSecretRead',
      actions: ['secretsmanager:GetSecretValue'],
      resources: [resendSecret.secretArn, supportMailSecret.secretArn],
    }),
  );

  queue.grantSendMessages(stripeWebhookFn);
  queue.grantSendMessages(entitlementsWebhookFn);
  stripeWebhookFn.addEnvironment(OWNER_NOTIFY_QUEUE_URL_ENV, queue.queueUrl);
  entitlementsWebhookFn.addEnvironment(OWNER_NOTIFY_QUEUE_URL_ENV, queue.queueUrl);

  new cdk.CfnOutput(scope, 'OwnerNotifyQueueUrl', {
    value: queue.queueUrl,
    description:
      'SQS queue for owner subscription emails (WARDROBE-273). Stripe and Superwall webhooks enqueue here.',
  });

  return {
    queue,
    dlq,
    fn,
  };
}
