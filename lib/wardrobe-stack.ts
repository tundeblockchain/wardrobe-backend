import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface WardrobeStackProps extends cdk.StackProps {
  stage?: string;
}

export class WardrobeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: WardrobeStackProps) {
    super(scope, id, props);

    const stage =
      props?.stage ??
      (this.node.tryGetContext('stage') as string | undefined) ??
      process.env.STAGE ??
      'dev';
    const isDev = stage === 'dev';
    const removalPolicy = isDev ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

    cdk.Tags.of(this).add('Service', 'wardrobe-backend');
    cdk.Tags.of(this).add('Stage', stage);

    // Single-table PK/SK matches backend.md §16–17 access patterns:
    // USER#{uid}          / PROFILE | WARDROBE#{wardrobeId}
    // WARDROBE#{wardrobeId} / ITEM#{itemId} | OUTFIT#{outfitId}
    const table = new dynamodb.Table(this, 'WardrobeTable', {
      tableName: `wardrobe-app-${stage}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      deletionProtection: !isDev,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: !isDev,
      },
      removalPolicy,
    });

    const mediaBucket = new s3.Bucket(this, 'MediaBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: false,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
      removalPolicy,
      autoDeleteObjects: isDev,
    });

    // WARDROBE-15 queue + WARDROBE-16 enqueue from ItemsFn. Real worker
    // behavior (WARDROBE-17 / AI) is a later ticket. The worker Lambda
    // below stays a no-op hook so the event source can be wired.
    const processingDlq = new sqs.Queue(this, 'ItemProcessingDlq', {
      queueName: `wardrobe-item-processing-dlq-${stage}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy,
    });

    const processingQueue = new sqs.Queue(this, 'ItemProcessingQueue', {
      queueName: `wardrobe-item-processing-${stage}`,
      // Visibility > ProcessingFn timeout (30s) so in-flight work is not
      // redelivered while the stub (and later worker) is still running.
      visibilityTimeout: cdk.Duration.seconds(60),
      retentionPeriod: cdk.Duration.days(4),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy,
      deadLetterQueue: {
        queue: processingDlq,
        maxReceiveCount: 3,
      },
    });

    const firebaseSecretName = `wardrobe/${stage}/firebase-project-id`;
    const firebaseProjectIdSecret = new secretsmanager.Secret(this, 'FirebaseProjectIdSecret', {
      secretName: firebaseSecretName,
      description:
        'Firebase project ID used to validate ID tokens. Replace the generated value with your Firebase project ID.',
      removalPolicy,
    });
    const commonLambdaProps: Partial<NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      environment: {
        STAGE: stage,
        TABLE_NAME: table.tableName,
        MEDIA_BUCKET_NAME: mediaBucket.bucketName,
        POWERTOOLS_SERVICE_NAME: 'wardrobe-backend',
      },
    };

    const authorizerFn = this.lambda('AuthorizerFn', 'authorizer', {
      ...commonLambdaProps,
      environment: {
        ...commonLambdaProps.environment,
        FIREBASE_PROJECT_ID_SECRET_ARN: firebaseProjectIdSecret.secretArn,
      },
    });
    firebaseProjectIdSecret.grantRead(authorizerFn);

    const healthFn = this.lambda('HealthFn', 'health', commonLambdaProps);
    const wardrobesFn = this.lambda('WardrobesFn', 'wardrobes', commonLambdaProps);
    const itemsFn = this.lambda('ItemsFn', 'items', {
      ...commonLambdaProps,
      environment: {
        ...commonLambdaProps.environment,
        PROCESSING_QUEUE_URL: processingQueue.queueUrl,
      },
    });
    const outfitsFn = this.lambda('OutfitsFn', 'outfits', commonLambdaProps);
    const uploadsFn = this.lambda('UploadsFn', 'uploads', commonLambdaProps);
    const processingFn = this.lambda('ProcessingFn', 'processing', {
      ...commonLambdaProps,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        ...commonLambdaProps.environment,
        PROCESSING_QUEUE_URL: processingQueue.queueUrl,
      },
    });

    table.grantReadWriteData(wardrobesFn);
    table.grantReadWriteData(itemsFn);
    table.grantReadWriteData(outfitsFn);
    table.grantReadWriteData(processingFn);
    mediaBucket.grantPut(uploadsFn);
    mediaBucket.grantReadWrite(processingFn);
    processingQueue.grantSendMessages(itemsFn);
    processingQueue.grantConsumeMessages(processingFn);

    processingFn.addEventSource(
      new SqsEventSource(processingQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    new cloudwatch.Alarm(this, 'ProcessingDlqAlarm', {
      alarmName: `wardrobe-item-processing-dlq-${stage}`,
      alarmDescription: 'Processing dead-letter queue contains messages',
      metric: processingDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'ProcessingQueueDepthAlarm', {
      alarmName: `wardrobe-item-processing-depth-${stage}`,
      alarmDescription: 'Processing queue approximate depth is high',
      metric: processingQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
      }),
      threshold: 25,
      evaluationPeriods: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'ProcessingQueueOldestMessageAlarm', {
      alarmName: `wardrobe-item-processing-oldest-${stage}`,
      alarmDescription: 'Oldest message in the processing queue exceeds age threshold',
      metric: processingQueue.metricApproximateAgeOfOldestMessage({
        period: cdk.Duration.minutes(1),
      }),
      threshold: 300,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const firebaseAuthorizer = new HttpLambdaAuthorizer(
      'FirebaseAuthorizer',
      authorizerFn,
      {
        authorizerName: `firebase-${stage}`,
        responseTypes: [HttpLambdaResponseType.SIMPLE],
        identitySource: ['$request.header.Authorization'],
        resultsCacheTtl: cdk.Duration.minutes(5),
      },
    );

    const apiAccessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: `/wardrobe/${stage}/http-api`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });
    apiAccessLogs.grantWrite(new iam.ServicePrincipal('apigateway.amazonaws.com'));

    const httpApi = new apigwv2.HttpApi(this, 'WardrobeApi', {
      apiName: `wardrobe-api-${stage}`,
      description: 'Digital Wardrobe HTTP API',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: cdk.Duration.days(1),
      },
    });

    const cfnDefaultStage = httpApi.defaultStage?.node.defaultChild as
      | apigwv2.CfnStage
      | undefined;
    if (cfnDefaultStage) {
      cfnDefaultStage.accessLogSettings = {
        destinationArn: apiAccessLogs.logGroupArn,
        format: JSON.stringify({
          requestId: '$context.requestId',
          ip: '$context.identity.sourceIp',
          requestTime: '$context.requestTime',
          httpMethod: '$context.httpMethod',
          routeKey: '$context.routeKey',
          status: '$context.status',
          protocol: '$context.protocol',
          responseLength: '$context.responseLength',
        }),
      };
    }

    const healthIntegration = new HttpLambdaIntegration('HealthIntegration', healthFn);
    const wardrobesIntegration = new HttpLambdaIntegration('WardrobesIntegration', wardrobesFn);
    const itemsIntegration = new HttpLambdaIntegration('ItemsIntegration', itemsFn);
    const outfitsIntegration = new HttpLambdaIntegration('OutfitsIntegration', outfitsFn);
    const uploadsIntegration = new HttpLambdaIntegration('UploadsIntegration', uploadsFn);

    httpApi.addRoutes({
      path: '/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: healthIntegration,
    });

    httpApi.addRoutes({
      path: '/wardrobes',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: wardrobesIntegration,
      authorizer: firebaseAuthorizer,
    });

    httpApi.addRoutes({
      path: '/wardrobes/{wardrobeId}',
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PATCH,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: wardrobesIntegration,
      authorizer: firebaseAuthorizer,
    });

    httpApi.addRoutes({
      path: '/wardrobes/{wardrobeId}/items',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: itemsIntegration,
      authorizer: firebaseAuthorizer,
    });

    httpApi.addRoutes({
      path: '/wardrobes/{wardrobeId}/items/{itemId}',
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PATCH,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: itemsIntegration,
      authorizer: firebaseAuthorizer,
    });

    httpApi.addRoutes({
      path: '/wardrobes/{wardrobeId}/outfits',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: outfitsIntegration,
      authorizer: firebaseAuthorizer,
    });

    httpApi.addRoutes({
      path: '/wardrobes/{wardrobeId}/outfits/{outfitId}',
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PATCH,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: outfitsIntegration,
      authorizer: firebaseAuthorizer,
    });

    httpApi.addRoutes({
      path: '/uploads',
      methods: [apigwv2.HttpMethod.POST],
      integration: uploadsIntegration,
      authorizer: firebaseAuthorizer,
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: httpApi.apiEndpoint,
      description: 'HTTP API base URL',
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB table name',
    });

    new cdk.CfnOutput(this, 'MediaBucketName', {
      value: mediaBucket.bucketName,
      description: 'S3 media bucket name',
    });

    new cdk.CfnOutput(this, 'ProcessingQueueUrl', {
      value: processingQueue.queueUrl,
      description: 'Item processing queue URL',
    });

    new cdk.CfnOutput(this, 'FirebaseProjectIdSecretName', {
      value: firebaseProjectIdSecret.secretName,
      description: 'Secrets Manager secret that must contain the Firebase project ID',
    });
  }

  private lambda(
    id: string,
    folder: string,
    props: Partial<NodejsFunctionProps>,
  ): NodejsFunction {
    const logGroup = new logs.LogGroup(this, `${id}Logs`, {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    return new NodejsFunction(this, id, {
      ...props,
      entry: path.join(__dirname, `../src/functions/${folder}/handler.ts`),
      handler: 'handler',
      logGroup,
    });
  }
}
