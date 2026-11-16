import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as fs from 'fs';
import * as path from 'path';
import { WardrobeStack } from '../../lib/wardrobe-stack';
import { ownerNotifyRecipientParamName } from '../../src/shared/owner-notify-names';

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
        Sid?: string;
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
):
  | { Timeout?: number; Environment?: { Variables?: Record<string, unknown> } }
  | undefined {
  const functions = Object.entries(
    template.findResources('AWS::Lambda::Function'),
  ) as Array<
    [
      string,
      {
        Properties: {
          Timeout?: number;
          Environment?: { Variables?: Record<string, unknown> };
        };
      },
    ]
  >;
  return functions.find(([id]) => id.includes(idIncludes))?.[1].Properties;
}

function policiesFor(template: Template, fnId: string): PolicyResource[] {
  const policies = Object.values(
    template.findResources('AWS::IAM::Policy'),
  ) as PolicyResource[];
  return policies.filter((policy) => JSON.stringify(policy).includes(fnId));
}

function actionsFor(
  template: Template,
  fnId: string,
  prefix: string,
): string[] {
  return policiesFor(template, fnId).flatMap((policy) =>
    policy.Properties.PolicyDocument.Statement.flatMap((statement) => {
      const actions = statement.Action;
      const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
      return list.filter((action) => action.startsWith(prefix));
    }),
  );
}

function statementsFor(
  template: Template,
  fnId: string,
  action: string,
): PolicyResource['Properties']['PolicyDocument']['Statement'] {
  return policiesFor(template, fnId).flatMap((policy) =>
    policy.Properties.PolicyDocument.Statement.filter((statement) => {
      const actions = statement.Action;
      const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
      return list.includes(action);
    }),
  );
}

describe('owner notify stack wiring (WARDROBE-273)', () => {
  const template = synthTemplate('dev');
  const recipientParam = ownerNotifyRecipientParamName('dev');

  test('does not create a queue, DLQ, or notifier Lambda', () => {
    expect(functionById(template, 'OwnerNotifyFn')).toBeUndefined();
    const queues = Object.values(
      template.findResources('AWS::SQS::Queue'),
    ) as Array<{ Properties: { QueueName?: string } }>;
    const names = queues.map((queue) => queue.Properties.QueueName ?? '');
    expect(names).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/owner-notify/i)]),
    );
    const stackJson = JSON.stringify(template.toJSON());
    expect(stackJson).not.toContain('wardrobe-owner-notify-dev');
    expect(stackJson).not.toContain('wardrobe-owner-notify-dlq-dev');
    expect(stackJson).not.toContain('OwnerNotifyQueue');
    expect(stackJson).not.toContain('OwnerNotifyDlq');
    const stackSource = fs.readFileSync(
      path.join(__dirname, '../../lib/wardrobe-stack.ts'),
      'utf8',
    );
    expect(stackSource).not.toContain('NOTIFY#');
  });

  test('wires the recipient SSM param and existing Resend secret onto webhook Lambdas', () => {
    const stripeEnv = functionEnvById(template, 'StripeWebhookFn');
    const superwallEnv = functionEnvById(template, 'EntitlementsWebhookFn');
    const supportEnv = functionEnvById(template, 'SupportFn');
    const billingEnv = functionEnvById(template, 'BillingFn');

    expect(stripeEnv).toEqual(
      expect.objectContaining({
        RESEND_SECRET_ARN: expect.anything(),
        OWNER_NOTIFY_RECIPIENT_PARAM: recipientParam,
        SUPPORT_FROM_EMAIL: expect.anything(),
      }),
    );
    expect(superwallEnv).toEqual(
      expect.objectContaining({
        RESEND_SECRET_ARN: expect.anything(),
        OWNER_NOTIFY_RECIPIENT_PARAM: recipientParam,
        SUPPORT_FROM_EMAIL: expect.anything(),
      }),
    );
    expect(stripeEnv?.RESEND_SECRET_ARN).toEqual(supportEnv?.RESEND_SECRET_ARN);
    expect(superwallEnv?.RESEND_SECRET_ARN).toEqual(supportEnv?.RESEND_SECRET_ARN);
    expect(JSON.stringify(stripeEnv?.SUPPORT_FROM_EMAIL)).toContain('fromEmail');
    expect(JSON.stringify(superwallEnv?.SUPPORT_FROM_EMAIL)).toContain(
      'fromEmail',
    );

    expect(stripeEnv).not.toHaveProperty('OWNER_NOTIFY_QUEUE_URL');
    expect(superwallEnv).not.toHaveProperty('OWNER_NOTIFY_QUEUE_URL');
    expect(stripeEnv).not.toHaveProperty('SUPPORT_MAIL_SECRET_ARN');
    expect(superwallEnv).not.toHaveProperty('SUPPORT_MAIL_SECRET_ARN');
    expect(stripeEnv).not.toHaveProperty('OWNER_NOTIFY_RESEND_SECRET_ARN');
    expect(stripeEnv).not.toHaveProperty('OWNER_NOTIFY_SENDER_PARAM');
    expect(billingEnv).not.toHaveProperty('OWNER_NOTIFY_RECIPIENT_PARAM');
    expect(billingEnv).not.toHaveProperty('RESEND_SECRET_ARN');
  });

  test('grants GetSecretValue on the existing Resend secret and GetParameter on the recipient', () => {
    for (const fnId of ['StripeWebhookFn', 'EntitlementsWebhookFn']) {
      expect(actionsFor(template, fnId, 'ses:')).toEqual([]);
      expect(actionsFor(template, fnId, 'sqs:')).toEqual([]);
      expect(actionsFor(template, fnId, 'ssm:')).toEqual(['ssm:GetParameter']);

      const secretStatements = statementsFor(
        template,
        fnId,
        'secretsmanager:GetSecretValue',
      );
      const ownerSecret = secretStatements.filter((statement) =>
        JSON.stringify(statement).includes('OwnerNotifyExistingSecretRead'),
      );
      expect(ownerSecret).toHaveLength(1);
      const secretActions = ownerSecret[0].Action;
      expect(
        Array.isArray(secretActions) ? secretActions : [secretActions],
      ).toEqual(['secretsmanager:GetSecretValue']);
      const secretResources = JSON.stringify(ownerSecret[0].Resource);
      expect(secretResources).toContain('ResendSecret');
      expect(secretResources).not.toContain('SupportMailSecret');
      expect(secretResources).not.toContain('*');

      const paramStatements = statementsFor(template, fnId, 'ssm:GetParameter');
      expect(paramStatements).toHaveLength(1);
      expect(JSON.stringify(paramStatements[0].Resource)).toContain(
        'parameter/wardrobe/dev/owner-notify/recipient',
      );
    }

    const stackJson = JSON.stringify(template.toJSON());
    expect(stackJson).not.toMatch(/"ses:/);
    expect(stackJson).not.toContain('ses:SendEmail');
    expect(template.findResources('AWS::SSM::Parameter')).toEqual({});
    expect(stackJson).not.toContain('NOTIFY#*');

    const secrets = Object.values(
      template.findResources('AWS::SecretsManager::Secret'),
    ) as Array<{ Properties: { Name?: string } }>;
    const secretNames = secrets.map((secret) => secret.Properties.Name);
    expect(secretNames).toEqual(expect.arrayContaining(['wardrobe/dev/resend']));
    expect(secretNames).not.toContain('wardrobe/dev/resend-api-key');
  });

  test('does not hardcode mailbox addresses in the template', () => {
    const synthesized = JSON.stringify(template.toJSON());
    expect(synthesized).not.toMatch(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    );
    expect(synthesized).not.toContain('owner@');
    expect(synthesized).not.toMatch(/\bre_[A-Za-z0-9]+/);
    expect(synthesized).toContain('wardrobe/dev/resend');
    expect(synthesized).toContain('wardrobe/dev/support-mail');
    expect(synthesized).not.toContain('resend-api-key');
    expect(synthesized).toContain('/wardrobe/dev/owner-notify/recipient');
    expect(synthesized).not.toContain('/wardrobe/dev/owner-notify/sender');
  });

  test('stage suffix is applied to the recipient param', () => {
    const staging = synthTemplate('staging');
    const stripeEnv = functionEnvById(staging, 'StripeWebhookFn');
    expect(stripeEnv).toEqual(
      expect.objectContaining({
        OWNER_NOTIFY_RECIPIENT_PARAM: '/wardrobe/staging/owner-notify/recipient',
        RESEND_SECRET_ARN: expect.anything(),
      }),
    );
    staging.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'wardrobe/staging/resend',
    });
    expect(JSON.stringify(staging.toJSON())).not.toContain(
      'wardrobe-owner-notify-staging',
    );
  });

  test('exposes the recipient SSM parameter name', () => {
    template.hasOutput('OwnerNotifyRecipientParamName', {
      Value: recipientParam,
      Description: Match.stringLikeRegexp('operator sets its value'),
    });
    const outputIds = Object.keys(template.toJSON().Outputs ?? {});
    expect(outputIds).not.toContain('OwnerNotifyQueueUrl');
    expect(outputIds).not.toContain('OwnerNotifySenderParamName');
    expect(outputIds).not.toContain('OwnerNotifyResendSecretName');
  });
});
