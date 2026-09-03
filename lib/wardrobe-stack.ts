import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
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

    const table = new dynamodb.Table(this, 'WardrobeTable', {
      tableName: `wardrobe-app-${stage}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: !isDev,
      },
      removalPolicy,
    });

    const mediaBucket = new s3.Bucket(this, 'MediaBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
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

    const processingDlq = new sqs.Queue(this, 'ItemProcessingDlq', {
      queueName: `wardrobe-item-processing-dlq-${stage}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    const processingQueue = new sqs.Queue(this, 'ItemProcessingQueue', {
      queueName: `wardrobe-item-processing-${stage}`,
      visibilityTimeout: cdk.Duration.seconds(60),
      retentionPeriod: cdk.Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
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
    const firebaseProjectId = `{{resolve:secretsmanager:${firebaseSecretName}:SecretString:::}}`;

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
        PROCESSING_QUEUE_URL: processingQueue.queueUrl,
        POWERTOOLS_SERVICE_NAME: 'wardrobe-backend',
      },
    };

    const healthFn = this.lambda('HealthFn', 'health', commonLambdaProps);
    const wardrobesFn = this.lambda('WardrobesFn', 'wardrobes', commonLambdaProps);
    const itemsFn = this.lambda('ItemsFn', 'items', commonLambdaProps);
    const outfitsFn = this.lambda('OutfitsFn', 'outfits', commonLambdaProps);
    const uploadsFn = this.lambda('UploadsFn', 'uploads', commonLambdaProps);
    const processingFn = this.lambda('ProcessingFn', 'processing', {
      ...commonLambdaProps,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
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

    const jwtAuthorizer = new HttpJwtAuthorizer(
      'FirebaseAuthorizer',
      `https://securetoken.google.com/${firebaseProjectId}`,
      {
        jwtAudience: [firebaseProjectId],
        authorizerName: `firebase-${stage}`,
      },
    );

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
    httpApi.node.addDependency(firebaseProjectIdSecret);

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
      authorizer: jwtAuthorizer,
    });

    httpApi.addRoutes({
      path: '/wardrobes/{wardrobeId}',
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PATCH,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: wardrobesIntegration,
      authorizer: jwtAuthorizer,
    });

    httpApi.addRoutes({
      path: '/wardrobes/{wardrobeId}/items',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: itemsIntegration,
      authorizer: jwtAuthorizer,
    });

    httpApi.addRoutes({
      path: '/wardrobes/{wardrobeId}/items/{itemId}',
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PATCH,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: itemsIntegration,
      authorizer: jwtAuthorizer,
    });

    httpApi.addRoutes({
      path: '/wardrobes/{wardrobeId}/outfits',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: outfitsIntegration,
      authorizer: jwtAuthorizer,
    });

    httpApi.addRoutes({
      path: '/wardrobes/{wardrobeId}/outfits/{outfitId}',
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PATCH,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: outfitsIntegration,
      authorizer: jwtAuthorizer,
    });

    httpApi.addRoutes({
      path: '/uploads',
      methods: [apigwv2.HttpMethod.POST],
      integration: uploadsIntegration,
      authorizer: jwtAuthorizer,
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
