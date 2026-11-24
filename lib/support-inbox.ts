import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'path';
import {
  DEFAULT_FEEDBACK_EMAIL_RATE_LIMIT,
  DEFAULT_FEEDBACK_IP_RATE_LIMIT,
  DEFAULT_RATE_WINDOW_SECONDS,
  DEFAULT_UPLOAD_IP_RATE_LIMIT,
  SUPPORT_FEEDBACK_EMAIL_RATE_LIMIT_ENV,
  SUPPORT_FEEDBACK_IP_RATE_LIMIT_ENV,
  SUPPORT_FROM_EMAIL_ENV,
  SUPPORT_INBOX_ALLOWED_ORIGINS_ENV,
  SUPPORT_INBOX_APP_LINK_ENV,
  SUPPORT_INBOX_APP_LINK_PARAM_ENV,
  SUPPORT_INBOX_RATE_WINDOW_SECONDS_ENV,
  SUPPORT_INBOX_RECIPIENT_PARAM_ENV,
  RESEND_SECRET_ARN_ENV,
  SUPPORT_EMAIL_TIMEOUT_MS,
  SUPPORT_EMAIL_TIMEOUT_MS_ENV,
  SUPPORT_TABLE_NAME_ENV,
  SUPPORT_UPLOAD_IP_RATE_LIMIT_ENV,
  supportInboxAppLinkParamName,
  supportInboxRecipientParamName,
  supportTableName,
} from '../src/shared/support-inbox-names';
import { resolveSupportInboxAllowedOrigins } from './support-inbox-cors';

/**
 * Isolated WARDROBE-281 / WARDROBE-284 wiring (public feedback + admin inbox).
 * Kept out of the main stack body so support-mail rebase conflicts stay small.
 */
export interface SupportInboxProps {
  stage: string;
  isDev: boolean;
  httpApi: apigwv2.HttpApi;
  authorizer: HttpLambdaAuthorizer;
  mediaBucket: s3.Bucket;
  firebaseProjectIdSecret: secretsmanager.ISecret;
  resendSecret: secretsmanager.ISecret;
  supportMailSecret: secretsmanager.ISecret;
  commonLambdaProps: Partial<NodejsFunctionProps>;
  removalPolicy: cdk.RemovalPolicy;
}

export interface SupportInboxResources {
  table: dynamodb.Table;
  supportInboxFn: NodejsFunction;
  supportInboxAdminFn: NodejsFunction;
}

export function addSupportInbox(
  scope: Construct,
  props: SupportInboxProps,
): SupportInboxResources {
  const {
    stage,
    isDev,
    httpApi,
    authorizer,
    mediaBucket,
    firebaseProjectIdSecret,
    resendSecret,
    supportMailSecret,
    commonLambdaProps,
    removalPolicy,
  } = props;

  const table = new dynamodb.Table(scope, 'SupportTable', {
    tableName: supportTableName(stage),
    partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    encryption: dynamodb.TableEncryption.AWS_MANAGED,
    deletionProtection: !isDev,
    pointInTimeRecoverySpecification: {
      pointInTimeRecoveryEnabled: true,
    },
    timeToLiveAttribute: 'ttl',
    removalPolicy,
  });

  table.addGlobalSecondaryIndex({
    indexName: 'StatusLastMessageIndex',
    partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'lastMessageAt', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  table.addGlobalSecondaryIndex({
    indexName: 'UidLastMessageIndex',
    partitionKey: { name: 'uid', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'lastMessageAt', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  const allowedOrigins = resolveSupportInboxAllowedOrigins(scope);
  mediaBucket.addCorsRule({
    allowedMethods: [s3.HttpMethods.POST],
    allowedOrigins,
    allowedHeaders: ['*'],
    exposedHeaders: ['ETag', 'Location'],
    maxAge: 3000,
  });

  const recipientParamName = supportInboxRecipientParamName(stage);
  const appLinkParamName = supportInboxAppLinkParamName(stage);
  const recipientParamArn = ssmParameterArn(scope, recipientParamName);
  const appLinkParamArn = ssmParameterArn(scope, appLinkParamName);
  const fromEmail = supportMailSecret
    .secretValueFromJson('fromEmail')
    .unsafeUnwrap();

  const supportInboxFn = lambda(scope, 'SupportInboxFn', 'handler.ts', {
    ...commonLambdaProps,
    timeout: cdk.Duration.seconds(15),
    environment: {
      ...commonLambdaProps.environment,
      [SUPPORT_TABLE_NAME_ENV]: table.tableName,
      [RESEND_SECRET_ARN_ENV]: resendSecret.secretArn,
      [SUPPORT_FROM_EMAIL_ENV]: fromEmail,
      [SUPPORT_INBOX_RECIPIENT_PARAM_ENV]: recipientParamName,
      FIREBASE_PROJECT_ID_SECRET_ARN: firebaseProjectIdSecret.secretArn,
      [SUPPORT_INBOX_ALLOWED_ORIGINS_ENV]: allowedOrigins.join(','),
      [SUPPORT_FEEDBACK_IP_RATE_LIMIT_ENV]: readContextOrEnv(
        scope,
        'supportFeedbackIpRateLimit',
        process.env.SUPPORT_FEEDBACK_IP_RATE_LIMIT,
        String(DEFAULT_FEEDBACK_IP_RATE_LIMIT),
      ),
      [SUPPORT_FEEDBACK_EMAIL_RATE_LIMIT_ENV]: readContextOrEnv(
        scope,
        'supportFeedbackEmailRateLimit',
        process.env.SUPPORT_FEEDBACK_EMAIL_RATE_LIMIT,
        String(DEFAULT_FEEDBACK_EMAIL_RATE_LIMIT),
      ),
      [SUPPORT_UPLOAD_IP_RATE_LIMIT_ENV]: readContextOrEnv(
        scope,
        'supportUploadIpRateLimit',
        process.env.SUPPORT_UPLOAD_IP_RATE_LIMIT,
        String(DEFAULT_UPLOAD_IP_RATE_LIMIT),
      ),
      [SUPPORT_INBOX_RATE_WINDOW_SECONDS_ENV]: readContextOrEnv(
        scope,
        'supportInboxRateWindowSeconds',
        process.env.SUPPORT_INBOX_RATE_WINDOW_SECONDS,
        String(DEFAULT_RATE_WINDOW_SECONDS),
      ),
      [SUPPORT_EMAIL_TIMEOUT_MS_ENV]: readContextOrEnv(
        scope,
        'supportEmailTimeoutMs',
        process.env.SUPPORT_EMAIL_TIMEOUT_MS,
        String(SUPPORT_EMAIL_TIMEOUT_MS),
      ),
    },
  });

  table.grantReadWriteData(supportInboxFn);
  resendSecret.grantRead(supportInboxFn);
  firebaseProjectIdSecret.grantRead(supportInboxFn);
  mediaBucket.grantPut(supportInboxFn, 'support/*');
  mediaBucket.grantRead(supportInboxFn, 'support/*');
  supportInboxFn.addToRolePolicy(
    new iam.PolicyStatement({
      sid: 'SupportInboxRecipientRead',
      actions: ['ssm:GetParameter'],
      resources: [recipientParamArn],
    }),
  );

  const integration = new HttpLambdaIntegration(
    'SupportInboxIntegration',
    supportInboxFn,
  );

  // Public website + Flutter may POST without Firebase. A token, when
  // present, is verified in-Lambda. OPTIONS is answered by API-level
  // corsPreflight and never hits this Lambda.
  httpApi.addRoutes({
    path: '/support/upload-url',
    methods: [apigwv2.HttpMethod.POST],
    integration,
  });
  httpApi.addRoutes({
    path: '/support/feedback',
    methods: [apigwv2.HttpMethod.POST],
    integration,
  });

  const appLinkFromConfig = optionalContextOrEnv(
    scope,
    'supportInboxAppLink',
    process.env.SUPPORT_INBOX_APP_LINK,
  );

  const supportInboxAdminFn = lambda(scope, 'SupportInboxAdminFn', 'admin-handler.ts', {
    ...commonLambdaProps,
    timeout: cdk.Duration.seconds(15),
    environment: {
      ...commonLambdaProps.environment,
      [SUPPORT_TABLE_NAME_ENV]: table.tableName,
      [RESEND_SECRET_ARN_ENV]: resendSecret.secretArn,
      [SUPPORT_FROM_EMAIL_ENV]: fromEmail,
      [SUPPORT_INBOX_RECIPIENT_PARAM_ENV]: recipientParamName,
      [SUPPORT_INBOX_APP_LINK_PARAM_ENV]: appLinkParamName,
      ...(appLinkFromConfig
        ? { [SUPPORT_INBOX_APP_LINK_ENV]: appLinkFromConfig }
        : {}),
      FIREBASE_PROJECT_ID_SECRET_ARN: firebaseProjectIdSecret.secretArn,
      [SUPPORT_INBOX_ALLOWED_ORIGINS_ENV]: allowedOrigins.join(','),
      [SUPPORT_EMAIL_TIMEOUT_MS_ENV]: readContextOrEnv(
        scope,
        'supportEmailTimeoutMs',
        process.env.SUPPORT_EMAIL_TIMEOUT_MS,
        String(SUPPORT_EMAIL_TIMEOUT_MS),
      ),
    },
  });

  supportInboxAdminFn.addToRolePolicy(
    new iam.PolicyStatement({
      sid: 'SupportInboxAdminTable',
      actions: [
        'dynamodb:GetItem',
        'dynamodb:Query',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
      ],
      resources: [
        table.tableArn,
        `${table.tableArn}/index/StatusLastMessageIndex`,
      ],
    }),
  );
  supportInboxAdminFn.addToRolePolicy(
    new iam.PolicyStatement({
      sid: 'SupportInboxAdminScreenshotGet',
      actions: ['s3:GetObject'],
      resources: [mediaBucket.arnForObjects('support/*')],
    }),
  );
  supportInboxAdminFn.addToRolePolicy(
    new iam.PolicyStatement({
      sid: 'SupportInboxAdminSsmRead',
      actions: ['ssm:GetParameter'],
      resources: [recipientParamArn, appLinkParamArn],
    }),
  );
  resendSecret.grantRead(supportInboxAdminFn);
  firebaseProjectIdSecret.grantRead(supportInboxAdminFn);

  const adminIntegration = new HttpLambdaIntegration(
    'SupportInboxAdminIntegration',
    supportInboxAdminFn,
  );

  // Firebase authorizer plus in-Lambda `admin === true` claim check.
  // OPTIONS is answered by API-level corsPreflight (GET/POST + Authorization;
  // allowOrigins stays ['*'] for mobile). Admin UI origins match the
  // support-inbox allowlist (Netlify + localhost).
  const adminAuthorizer = { authorizer };
  httpApi.addRoutes({
    path: '/admin/support/conversations',
    methods: [apigwv2.HttpMethod.GET],
    integration: adminIntegration,
    ...adminAuthorizer,
  });
  httpApi.addRoutes({
    path: '/admin/support/conversations/{conversationId}',
    methods: [apigwv2.HttpMethod.GET],
    integration: adminIntegration,
    ...adminAuthorizer,
  });
  httpApi.addRoutes({
    path: '/admin/support/conversations/{conversationId}/replies',
    methods: [apigwv2.HttpMethod.POST],
    integration: adminIntegration,
    ...adminAuthorizer,
  });
  httpApi.addRoutes({
    path: '/admin/support/conversations/{conversationId}/close',
    methods: [apigwv2.HttpMethod.POST],
    integration: adminIntegration,
    ...adminAuthorizer,
  });
  httpApi.addRoutes({
    path: '/admin/support/conversations/{conversationId}/messages/{messageId}/retry-email',
    methods: [apigwv2.HttpMethod.POST],
    integration: adminIntegration,
    ...adminAuthorizer,
  });

  new cdk.CfnOutput(scope, 'SupportTableName', {
    value: table.tableName,
    description:
      'Separate DynamoDB table for threaded support conversations (WARDROBE-281)',
  });
  new cdk.CfnOutput(scope, 'SupportInboxRecipientParamName', {
    value: recipientParamName,
    description:
      'SSM parameter for the support inbox recipient. The operator sets its value.',
  });
  new cdk.CfnOutput(scope, 'SupportInboxAppLinkParamName', {
    value: appLinkParamName,
    description:
      'SSM parameter for the Pocket Closet app link used in admin reply emails. The operator sets its value. Omit to send replies without the link.',
  });

  return { table, supportInboxFn, supportInboxAdminFn };
}

function readContextOrEnv(
  scope: Construct,
  contextKey: string,
  envValue: string | undefined,
  fallback: string,
): string {
  const fromContext = scope.node.tryGetContext(contextKey);
  if (typeof fromContext === 'string' && fromContext.trim().length > 0) {
    return fromContext.trim();
  }
  if (typeof envValue === 'string' && envValue.trim().length > 0) {
    return envValue.trim();
  }
  return fallback;
}

function optionalContextOrEnv(
  scope: Construct,
  contextKey: string,
  envValue: string | undefined,
): string | undefined {
  const value = readContextOrEnv(scope, contextKey, envValue, '');
  return value.length > 0 ? value : undefined;
}

function ssmParameterArn(scope: Construct, parameterName: string): string {
  return cdk.Stack.of(scope).formatArn({
    service: 'ssm',
    resource: 'parameter',
    resourceName: parameterName.replace(/^\//, ''),
  });
}

function lambda(
  scope: Construct,
  id: string,
  entryFile: string,
  props: Partial<NodejsFunctionProps>,
): NodejsFunction {
  const logGroup = new logs.LogGroup(scope, `${id}Logs`, {
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  return new NodejsFunction(scope, id, {
    ...props,
    entry: path.join(__dirname, `../src/functions/support-inbox/${entryFile}`),
    handler: 'handler',
    logGroup,
  });
}
