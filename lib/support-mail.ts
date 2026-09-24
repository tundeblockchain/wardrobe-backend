import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * Isolated WARDROBE-38 / WARDROBE-143 wiring (Resend outbound + inbound webhook).
 * Kept out of the main stack body so WARDROBE-36 /me rebase conflicts stay small.
 */
export interface SupportMailProps {
  stage: string;
  httpApi: apigwv2.HttpApi;
  authorizer: HttpLambdaAuthorizer;
  table: dynamodb.ITable;
  firebaseProjectIdSecret: secretsmanager.ISecret;
  commonLambdaProps: Partial<NodejsFunctionProps>;
  removalPolicy: cdk.RemovalPolicy;
}

export interface SupportMailResources {
  resendSecret: secretsmanager.Secret;
  supportMailSecret: secretsmanager.Secret;
  supportFn: NodejsFunction;
  webhookFn: NodejsFunction;
}

export function addSupportMail(
  scope: Construct,
  props: SupportMailProps,
): SupportMailResources {
  const {
    stage,
    httpApi,
    authorizer,
    table,
    firebaseProjectIdSecret,
    commonLambdaProps,
    removalPolicy,
  } = props;

  const resendSecret = new secretsmanager.Secret(scope, 'ResendSecret', {
    secretName: `wardrobe/${stage}/resend`,
    description:
      'Resend credentials for support mail (WARDROBE-38). Store JSON { "apiKey", "webhookSecret" } or a raw API key. Never commit the real key.',
    removalPolicy,
  });

  const supportMailSecret = new secretsmanager.Secret(scope, 'SupportMailSecret', {
    secretName: `wardrobe/${stage}/support-mail`,
    description:
      'Support mailbox addresses (WARDROBE-38). Store JSON { "fromEmail", "forwardTo" }. fromEmail is the custom-domain sender; forwardTo is Tunde’s mailbox.',
    removalPolicy,
  });

  const sharedSupportEnv = {
    ...commonLambdaProps.environment,
    RESEND_SECRET_ARN: resendSecret.secretArn,
    SUPPORT_MAIL_SECRET_ARN: supportMailSecret.secretArn,
  };

  const allowedOrigins = readContextOrEnv(
    scope,
    'supportContactAllowedOrigins',
    process.env.SUPPORT_CONTACT_ALLOWED_ORIGINS,
    '',
  );
  const rateLimit = readContextOrEnv(
    scope,
    'supportContactRateLimit',
    process.env.SUPPORT_CONTACT_RATE_LIMIT,
    '5',
  );
  const rateWindowSeconds = readContextOrEnv(
    scope,
    'supportContactRateWindowSeconds',
    process.env.SUPPORT_CONTACT_RATE_WINDOW_SECONDS,
    '3600',
  );

  const supportFn = lambda(scope, 'SupportFn', 'support', {
    ...commonLambdaProps,
    timeout: cdk.Duration.seconds(15),
    environment: {
      ...sharedSupportEnv,
      FIREBASE_PROJECT_ID_SECRET_ARN: firebaseProjectIdSecret.secretArn,
      SUPPORT_CONTACT_ALLOWED_ORIGINS: allowedOrigins,
      SUPPORT_CONTACT_RATE_LIMIT: rateLimit,
      SUPPORT_CONTACT_RATE_WINDOW_SECONDS: rateWindowSeconds,
    },
  });

  const webhookFn = lambda(scope, 'SupportWebhookFn', 'support-webhook', {
    ...commonLambdaProps,
    timeout: cdk.Duration.seconds(15),
    environment: sharedSupportEnv,
  });

  resendSecret.grantRead(supportFn);
  resendSecret.grantRead(webhookFn);
  supportMailSecret.grantRead(supportFn);
  supportMailSecret.grantRead(webhookFn);
  firebaseProjectIdSecret.grantRead(supportFn);

  supportFn.addToRolePolicy(
    new iam.PolicyStatement({
      sid: 'SupportContactRateLimit',
      actions: ['dynamodb:UpdateItem'],
      resources: [table.tableArn],
      conditions: {
        'ForAllValues:StringLike': {
          'dynamodb:LeadingKeys': ['RATE#SUPPORT_CONTACT#*'],
        },
      },
    }),
  );

  const supportIntegration = new HttpLambdaIntegration(
    'SupportIntegration',
    supportFn,
  );
  const webhookIntegration = new HttpLambdaIntegration(
    'SupportWebhookIntegration',
    webhookFn,
  );

  // WARDROBE-143: public website may POST without Firebase. Token, when
  // present, is verified in-Lambda. /support/bug stays on the authorizer.
  // OPTIONS preflight is answered by API-level corsPreflight (allowOrigins
  // ['*']) and never hits this authorizer.
  httpApi.addRoutes({
    path: '/support/contact',
    methods: [apigwv2.HttpMethod.POST],
    integration: supportIntegration,
  });

  httpApi.addRoutes({
    path: '/support/bug',
    methods: [apigwv2.HttpMethod.POST],
    integration: supportIntegration,
    authorizer,
  });

  httpApi.addRoutes({
    path: '/webhooks/resend',
    methods: [apigwv2.HttpMethod.POST],
    integration: webhookIntegration,
  });

  new cdk.CfnOutput(scope, 'ResendSecretName', {
    value: resendSecret.secretName,
    description:
      'Secrets Manager secret for Resend API key + webhook signing secret (placeholder until replaced)',
  });

  new cdk.CfnOutput(scope, 'SupportMailSecretName', {
    value: supportMailSecret.secretName,
    description:
      'Secrets Manager secret for SUPPORT_FROM_EMAIL and SUPPORT_FORWARD_TO (placeholder until replaced)',
  });

  new cdk.CfnOutput(scope, 'SupportWebhookUrl', {
    value: `${httpApi.apiEndpoint}/webhooks/resend`,
    description: 'Public Resend inbound webhook URL (no Firebase auth; Svix-signed)',
  });

  return { resendSecret, supportMailSecret, supportFn, webhookFn };
}

function readContextOrEnv(
  scope: Construct,
  contextKey: string,
  envValue: string | undefined,
  fallback: string,
): string {
  const fromContext = scope.node.tryGetContext(contextKey);
  if (typeof fromContext === 'string') {
    return fromContext.trim();
  }
  if (typeof envValue === 'string' && envValue.trim().length > 0) {
    return envValue.trim();
  }
  return fallback;
}

function lambda(
  scope: Construct,
  id: string,
  folder: string,
  props: Partial<NodejsFunctionProps>,
): NodejsFunction {
  const logGroup = new logs.LogGroup(scope, `${id}Logs`, {
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  return new NodejsFunction(scope, id, {
    ...props,
    entry: path.join(__dirname, `../src/functions/${folder}/handler.ts`),
    handler: 'handler',
    logGroup,
  });
}
