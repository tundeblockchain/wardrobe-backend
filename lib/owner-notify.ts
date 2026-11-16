import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as path from 'path';
import {
  OWNER_NOTIFY_QUEUE_URL_ENV,
  OWNER_NOTIFY_RECIPIENT_PARAM_ENV,
  OWNER_NOTIFY_SENDER_PARAM_ENV,
  ownerNotifyRecipientParamName,
  ownerNotifySenderParamName,
} from '../src/shared/owner-notify-names';

/**
 * Isolated WARDROBE-273 wiring (owner subscription emails via SES).
 *
 * Webhook Lambdas enqueue to SQS. A dedicated notifier reads SSM (or env)
 * for the sender / recipient, dedupes in Dynamo, and calls SES. Recipient
 * and sender values are never hardcoded. The sender parameter is resolved
 * at deploy time into the ses:SendEmail identity ARN.
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
  recipientParamName: string;
  senderParamName: string;
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
      [OWNER_NOTIFY_RECIPIENT_PARAM_ENV]: recipientParamName,
      [OWNER_NOTIFY_SENDER_PARAM_ENV]: senderParamName,
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

  const stack = cdk.Stack.of(scope);
  const senderIdentity = ssm.StringParameter.valueForStringParameter(
    scope,
    senderParamName,
  );
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      sid: 'OwnerNotifySesSend',
      actions: ['ses:SendEmail'],
      resources: [
        stack.formatArn({
          service: 'ses',
          resource: 'identity',
          resourceName: senderIdentity,
          arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
        }),
      ],
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
  new cdk.CfnOutput(scope, 'OwnerNotifyRecipientParamName', {
    value: recipientParamName,
    description:
      'SSM parameter name for the owner-notify recipient address. Values are never stored in CDK.',
  });
  new cdk.CfnOutput(scope, 'OwnerNotifySenderParamName', {
    value: senderParamName,
    description:
      'SSM parameter name for the owner-notify SES sender identity. Must exist at deploy time so CloudFormation can scope ses:SendEmail to that identity ARN.',
  });

  return { queue, dlq, fn, recipientParamName, senderParamName };
}

function parameterArn(scope: Construct, name: string): string {
  const stack = cdk.Stack.of(scope);
  const trimmed = name.startsWith('/') ? name.slice(1) : name;
  return `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter/${trimmed}`;
}
