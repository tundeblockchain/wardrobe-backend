import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { WardrobeStack } from '../../lib/wardrobe-stack';
import {
  OWNER_NOTIFY_LAMBDA_TIMEOUT_SECONDS,
  OWNER_NOTIFY_MAX_RECEIVE_COUNT,
} from '../../lib/owner-notify';

jest.setTimeout(180_000);

function synthTemplate(stage = 'dev'): Template {
  const previousStrategy = process.env.RECOMMENDER_STRATEGY;
  delete process.env.RECOMMENDER_STRATEGY;
  try {
    const app = new cdk.App();
    const stack = new WardrobeStack(app, `WardrobeStack-${stage}`, { stage });
    return Template.fromStack(stack);
  } finally {
    if (previousStrategy === undefined) {
      delete process.env.RECOMMENDER_STRATEGY;
    } else {
      process.env.RECOMMENDER_STRATEGY = previousStrategy;
    }
  }
}

type PolicyResource = {
  Properties: {
    PolicyDocument: {
      Statement: Array<{
        Action?: string | string[];
        Resource?: unknown;
        Condition?: unknown;
      }>;
    };
  };
};

function functionEnvById(
  template: Template,
  idIncludes: string,
): Record<string, unknown> | undefined {
  const functions = Object.entries(
    template.findResources('AWS::Lambda::Function'),
  ) as Array<
    [
      string,
      {
        Properties: {
          Environment?: { Variables?: Record<string, unknown> };
          Timeout?: number;
        };
      },
    ]
  >;
  return functions.find(([id]) => id.includes(idIncludes))?.[1].Properties
    .Environment?.Variables;
}

function functionById(
  template: Template,
  idIncludes: string,
): { Timeout?: number; Environment?: { Variables?: Record<string, unknown> } } | undefined {
  const functions = Object.entries(
    template.findResources('AWS::Lambda::Function'),
  ) as Array<[string, { Properties: { Timeout?: number; Environment?: { Variables?: Record<string, unknown> } } }]>;
  return functions.find(([id]) => id.includes(idIncludes))?.[1].Properties;
}

function actionsFor(
  template: Template,
  fnId: string,
  prefix: string,
): string[] {
  const policies = Object.values(
    template.findResources('AWS::IAM::Policy'),
  ) as PolicyResource[];
  return policies
    .filter((policy) => JSON.stringify(policy).includes(fnId))
    .flatMap((policy) =>
      policy.Properties.PolicyDocument.Statement.flatMap((statement) => {
        const actions = statement.Action;
        const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
        return list.filter((action) => action.startsWith(prefix));
      }),
    );
}

describe('owner notify stack wiring (WARDROBE-273)', () => {
  const template = synthTemplate('dev');

  test('creates an owner-notify queue and DLQ', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'wardrobe-owner-notify-dev',
      VisibilityTimeout: OWNER_NOTIFY_LAMBDA_TIMEOUT_SECONDS * 2,
      MessageRetentionPeriod: 345600,
      ReceiveMessageWaitTimeSeconds: 20,
      SqsManagedSseEnabled: true,
      RedrivePolicy: {
        maxReceiveCount: OWNER_NOTIFY_MAX_RECEIVE_COUNT,
        deadLetterTargetArn: {
          'Fn::GetAtt': [Match.stringLikeRegexp('OwnerNotifyDlq'), 'Arn'],
        },
      },
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'wardrobe-owner-notify-dlq-dev',
      VisibilityTimeout: OWNER_NOTIFY_LAMBDA_TIMEOUT_SECONDS * 2,
      MessageRetentionPeriod: 1209600,
      SqsManagedSseEnabled: true,
      RedrivePolicy: Match.absent(),
    });
  });

  test('webhook Lambdas enqueue; only OwnerNotifyFn reads the Resend secret', () => {
    const stripeEnv = functionEnvById(template, 'StripeWebhookFn');
    const superwallEnv = functionEnvById(template, 'EntitlementsWebhookFn');
    const notifyEnv = functionEnvById(template, 'OwnerNotifyFn');
    const billingEnv = functionEnvById(template, 'BillingFn');

    expect(stripeEnv).toEqual(
      expect.objectContaining({
        OWNER_NOTIFY_QUEUE_URL: expect.anything(),
      }),
    );
    expect(superwallEnv).toEqual(
      expect.objectContaining({
        OWNER_NOTIFY_QUEUE_URL: expect.anything(),
      }),
    );
    expect(notifyEnv).toEqual(
      expect.objectContaining({
        OWNER_NOTIFY_QUEUE_URL: expect.anything(),
        OWNER_NOTIFY_RECIPIENT_PARAM: '/wardrobe/dev/owner-notify/recipient',
        OWNER_NOTIFY_SENDER_PARAM: '/wardrobe/dev/owner-notify/sender',
        OWNER_NOTIFY_RESEND_SECRET_ARN: expect.anything(),
      }),
    );
    expect(billingEnv).not.toHaveProperty('OWNER_NOTIFY_QUEUE_URL');
    expect(stripeEnv).not.toHaveProperty('OWNER_NOTIFY_RESEND_SECRET_ARN');
    expect(superwallEnv).not.toHaveProperty('OWNER_NOTIFY_RESEND_SECRET_ARN');

    expect(actionsFor(template, 'StripeWebhookFn', 'sqs:')).toEqual(
      expect.arrayContaining(['sqs:SendMessage']),
    );
    expect(actionsFor(template, 'EntitlementsWebhookFn', 'sqs:')).toEqual(
      expect.arrayContaining(['sqs:SendMessage']),
    );
    expect(actionsFor(template, 'StripeWebhookFn', 'ses:')).toEqual([]);
    expect(actionsFor(template, 'EntitlementsWebhookFn', 'ses:')).toEqual([]);
    expect(actionsFor(template, 'BillingFn', 'ses:')).toEqual([]);
    expect(actionsFor(template, 'OwnerNotifyFn', 'ses:')).toEqual([]);
    expect(actionsFor(template, 'OwnerNotifyFn', 'ssm:')).toEqual(
      expect.arrayContaining(['ssm:GetParameter', 'ssm:GetParameters']),
    );
    expect(actionsFor(template, 'OwnerNotifyFn', 'dynamodb:')).toEqual(
      expect.arrayContaining(['dynamodb:PutItem', 'dynamodb:DeleteItem']),
    );
    expect(actionsFor(template, 'OwnerNotifyFn', 'secretsmanager:')).toEqual(
      expect.arrayContaining(['secretsmanager:GetSecretValue']),
    );

    const notifyTimeout = functionById(template, 'OwnerNotifyFn')?.Timeout;
    expect(notifyTimeout).toBe(OWNER_NOTIFY_LAMBDA_TIMEOUT_SECONDS);
  });

  test('Resend secret grant is scoped and SES permissions are absent', () => {
    const policies = Object.values(
      template.findResources('AWS::IAM::Policy'),
    ) as PolicyResource[];
    const ownerPolicies = policies.filter((policy) =>
      JSON.stringify(policy).includes('OwnerNotifyFn'),
    );
    const serialized = JSON.stringify(ownerPolicies);
    expect(serialized).toContain('secretsmanager:GetSecretValue');
    expect(serialized).not.toContain('ses:');
    expect(serialized).not.toContain('ses:SendEmail');
    expect(serialized).not.toContain(':identity/');
    expect(serialized).toContain('parameter/wardrobe/dev/owner-notify/recipient');
    expect(serialized).toContain('parameter/wardrobe/dev/owner-notify/sender');
    expect(serialized).toContain('NOTIFY#*');

    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/dev/resend-api-key',
    });
  });

  test('does not hardcode mailbox addresses in the template', () => {
    const synthesized = JSON.stringify(template.toJSON());
    expect(synthesized).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(synthesized).not.toContain('owner@');
    expect(synthesized).not.toMatch(/\bre_[A-Za-z0-9]+/);
    expect(synthesized).toContain('/wardrobe/dev/owner-notify/recipient');
    expect(synthesized).toContain('/wardrobe/dev/owner-notify/sender');
    expect(synthesized).toContain('wardrobe/dev/resend-api-key');
  });

  test('stage suffix is applied to queue and SSM parameter names', () => {
    const staging = synthTemplate('staging');
    staging.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'wardrobe-owner-notify-staging',
    });
    const notifyEnv = functionEnvById(staging, 'OwnerNotifyFn');
    expect(notifyEnv).toEqual(
      expect.objectContaining({
        OWNER_NOTIFY_RECIPIENT_PARAM: '/wardrobe/staging/owner-notify/recipient',
        OWNER_NOTIFY_SENDER_PARAM: '/wardrobe/staging/owner-notify/sender',
      }),
    );
    staging.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/staging/resend-api-key',
    });
  });

  test('exposes queue and SSM parameter name outputs', () => {
    template.hasOutput('OwnerNotifyQueueUrl', {
      Description: Match.stringLikeRegexp('owner subscription emails'),
    });
    template.hasOutput('OwnerNotifyRecipientParamName', {
      Value: '/wardrobe/dev/owner-notify/recipient',
    });
    template.hasOutput('OwnerNotifySenderParamName', {
      Value: '/wardrobe/dev/owner-notify/sender',
    });
    template.hasOutput('OwnerNotifyResendSecretName', {
      Value: 'wardrobe/dev/resend-api-key',
    });
  });
});
