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
    const supportEnv = functionEnvById(template, 'SupportFn');
    expect(notifyEnv).toEqual(
      expect.objectContaining({
        OWNER_NOTIFY_QUEUE_URL: expect.anything(),
        RESEND_SECRET_ARN: expect.anything(),
        SUPPORT_MAIL_SECRET_ARN: expect.anything(),
      }),
    );
    expect(notifyEnv?.RESEND_SECRET_ARN).toEqual(supportEnv?.RESEND_SECRET_ARN);
    expect(notifyEnv?.SUPPORT_MAIL_SECRET_ARN).toEqual(
      supportEnv?.SUPPORT_MAIL_SECRET_ARN,
    );
    expect(notifyEnv).not.toHaveProperty('OWNER_NOTIFY_RESEND_SECRET_ARN');
    expect(notifyEnv).not.toHaveProperty('OWNER_NOTIFY_RECIPIENT_PARAM');
    expect(notifyEnv).not.toHaveProperty('OWNER_NOTIFY_SENDER_PARAM');
    expect(billingEnv).not.toHaveProperty('OWNER_NOTIFY_QUEUE_URL');
    expect(stripeEnv).not.toHaveProperty('RESEND_SECRET_ARN');
    expect(superwallEnv).not.toHaveProperty('RESEND_SECRET_ARN');

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
    expect(actionsFor(template, 'OwnerNotifyFn', 'ssm:')).toEqual([]);
    expect(actionsFor(template, 'OwnerNotifyFn', 'dynamodb:')).toEqual(
      expect.arrayContaining(['dynamodb:PutItem', 'dynamodb:DeleteItem']),
    );
    expect(actionsFor(template, 'OwnerNotifyFn', 'secretsmanager:')).toEqual([
      'secretsmanager:GetSecretValue',
    ]);

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
    expect(serialized).not.toContain('secretsmanager:DescribeSecret');
    expect(serialized).not.toContain('ses:');
    expect(serialized).not.toContain('ses:SendEmail');
    expect(serialized).not.toContain(':identity/');
    const stackJson = JSON.stringify(template.toJSON());
    expect(stackJson).not.toMatch(/"ses:/);
    expect(stackJson).not.toContain('ses:SendEmail');
    expect(template.findResources('AWS::SSM::Parameter')).toEqual({});
    expect(serialized).toContain('ResendSecret');
    expect(serialized).toContain('SupportMailSecret');
    expect(serialized).toContain('OwnerNotifyExistingSecretRead');
    expect(serialized).not.toContain('"Ref":"OwnerNotifyResendSecret');
    expect(serialized).not.toContain('parameter/wardrobe/dev/owner-notify/recipient');
    expect(serialized).not.toContain('parameter/wardrobe/dev/owner-notify/sender');
    expect(serialized).toContain('NOTIFY#*');

    const secrets = Object.values(
      template.findResources('AWS::SecretsManager::Secret'),
    ) as Array<{ Properties: { Name?: string } }>;
    const secretNames = secrets.map((secret) => secret.Properties.Name);
    expect(secretNames).toEqual(expect.arrayContaining(['wardrobe/dev/resend']));
    expect(secretNames).not.toContain('wardrobe/dev/resend-api-key');

    const secretStatements = ownerPolicies.flatMap((policy) =>
      policy.Properties.PolicyDocument.Statement.filter((statement) => {
        const actions = statement.Action;
        const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
        return list.includes('secretsmanager:GetSecretValue');
      }),
    );
    expect(secretStatements).toHaveLength(1);
    const secretActions = secretStatements[0].Action;
    expect(
      Array.isArray(secretActions) ? secretActions : [secretActions],
    ).toEqual(['secretsmanager:GetSecretValue']);
    const secretResources = JSON.stringify(secretStatements[0].Resource);
    expect(secretResources).toContain('ResendSecret');
    expect(secretResources).toContain('SupportMailSecret');
    expect(secretResources).not.toContain('*');
  });

  test('does not hardcode mailbox addresses in the template', () => {
    const synthesized = JSON.stringify(template.toJSON());
    expect(synthesized).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(synthesized).not.toContain('owner@');
    expect(synthesized).not.toMatch(/\bre_[A-Za-z0-9]+/);
    expect(synthesized).toContain('wardrobe/dev/resend');
    expect(synthesized).toContain('wardrobe/dev/support-mail');
    expect(synthesized).not.toContain('resend-api-key');
    expect(synthesized).not.toContain('/wardrobe/dev/owner-notify/recipient');
    expect(synthesized).not.toContain('/wardrobe/dev/owner-notify/sender');
  });

  test('stage suffix is applied to the owner-notify queue', () => {
    const staging = synthTemplate('staging');
    staging.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'wardrobe-owner-notify-staging',
    });
    const notifyEnv = functionEnvById(staging, 'OwnerNotifyFn');
    expect(notifyEnv).toEqual(
      expect.objectContaining({
        RESEND_SECRET_ARN: expect.anything(),
        SUPPORT_MAIL_SECRET_ARN: expect.anything(),
      }),
    );
    staging.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/staging/resend',
    });
  });

  test('exposes the owner-notify queue URL', () => {
    template.hasOutput('OwnerNotifyQueueUrl', {
      Description: Match.stringLikeRegexp('owner subscription emails'),
    });
    const outputIds = Object.keys(template.toJSON().Outputs ?? {});
    expect(outputIds).not.toContain('OwnerNotifyRecipientParamName');
    expect(outputIds).not.toContain('OwnerNotifySenderParamName');
    expect(outputIds).not.toContain('OwnerNotifyResendSecretName');
  });
});
