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
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'path';
import {
  GENERIC_MODEL_CATALOG_VERSION,
  genericModelIds,
} from '../src/functions/ai-profiles/catalog';
import { tryOnSecretName } from '../src/functions/ai-profiles/hooks';
import { addSupportMail } from './support-mail';

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
    // USER#{uid}                 / PROFILE | WARDROBE#{wardrobeId} | AIPROFILE#{id}
    // WARDROBE#{wardrobeId}      / ITEM#{itemId} | OUTFIT#{outfitId}
    // AIPROFILE#GENERIC_MODEL    / AIPROFILE#{id}
    // GSI1 (sparse): TYPE#GENERIC_MODEL / AIPROFILE#{id}
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

    // WARDROBE-43: list GENERIC_MODEL profiles for the try-on picker.
    // PERSONAL rows omit GSI1 attributes (sparse). WARDROBE-45 seeds catalog + GSI1
    // at deploy via GenericModelSeedFn.
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
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

    // WARDROBE-15 queue + WARDROBE-16 enqueue + WARDROBE-17 worker +
    // WARDROBE-18/26 Gemini bg-remove + WARDROBE-19/27 Gemini classify +
    // WARDROBE-20/29 Gemini colour. Visibility must stay greater than the worker
    // timeout so an in-flight Gemini / vision invoke is not redelivered. After
    // maxReceiveCount: 3 SQS sends the message to the DLQ (alarmed
    // below). No EventBridge.
    const processingLambdaTimeout = cdk.Duration.seconds(60);
    const processingVisibilityTimeout = cdk.Duration.seconds(120);

    const processingDlq = new sqs.Queue(this, 'ItemProcessingDlq', {
      queueName: `wardrobe-item-processing-dlq-${stage}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy,
    });

    const processingQueue = new sqs.Queue(this, 'ItemProcessingQueue', {
      queueName: `wardrobe-item-processing-${stage}`,
      visibilityTimeout: processingVisibilityTimeout,
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

    // WARDROBE-47 try-on queue. Same Phase-2 pattern (enqueue → worker →
    // DLQ after 3 receives). Dedicated so PROCESS_WARDROBE_ITEM poison
    // handling and item-processing alarms stay isolated.
    const tryOnDlq = new sqs.Queue(this, 'OutfitRenderDlq', {
      queueName: `wardrobe-outfit-render-dlq-${stage}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy,
    });

    const tryOnQueue = new sqs.Queue(this, 'OutfitRenderQueue', {
      queueName: `wardrobe-outfit-render-${stage}`,
      visibilityTimeout: processingVisibilityTimeout,
      retentionPeriod: cdk.Duration.days(4),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy,
      deadLetterQueue: {
        queue: tryOnDlq,
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
    const backgroundRemovalSecret = new secretsmanager.Secret(
      this,
      'BackgroundRemovalSecret',
      {
        secretName: `wardrobe/${stage}/gemini-background-removal`,
        description:
          'Gemini background-removal credentials. Replace the generated value with a Gemini API key, or JSON { "apiKey", "model", "endpoint" }. Never commit the real key.',
        removalPolicy,
      },
    );
    const geminiModel =
      (this.node.tryGetContext('geminiModel') as string | undefined) ??
      process.env.GEMINI_MODEL ??
      '';
    const geminiEndpoint =
      (this.node.tryGetContext('geminiEndpoint') as string | undefined) ??
      process.env.GEMINI_ENDPOINT ??
      '';
    const geminiColourModel =
      (this.node.tryGetContext('geminiColourModel') as string | undefined) ??
      process.env.GEMINI_COLOUR_MODEL ??
      '';
    const geminiColourEndpoint =
      (this.node.tryGetContext('geminiColourEndpoint') as string | undefined) ??
      process.env.GEMINI_COLOUR_ENDPOINT ??
      '';
    const colourDetectorStrategy =
      (
        (this.node.tryGetContext('colourDetectorStrategy') as string | undefined) ??
        process.env.COLOUR_DETECTOR_STRATEGY ??
        'gemini'
      ).trim() || 'gemini';

    const geminiClassifierModel =
      (this.node.tryGetContext('geminiClassifierModel') as string | undefined) ??
      process.env.GEMINI_CLASSIFIER_MODEL ??
      '';
    const geminiClassifierEndpoint =
      (this.node.tryGetContext('geminiClassifierEndpoint') as
        | string
        | undefined) ??
      process.env.GEMINI_CLASSIFIER_ENDPOINT ??
      '';

    // Placeholder only — replace the generated value with a Gemini API
    // key (plain string or JSON { apiKey, model, endpoint }). Never commit AI keys.
    const aiClassifierSecret = new secretsmanager.Secret(this, 'AiClassifierSecret', {
      secretName: `wardrobe/${stage}/gemini-classifier`,
      description:
        'Gemini garment-classification credentials. Replace the generated value with a Gemini API key, or JSON { "apiKey", "model", "endpoint" }. Never commit the real key.',
      removalPolicy,
    });
    // Placeholder only — replace the generated value with a Gemini API
    // key (or JSON { apiKey, model, endpoint }). Never commit AI keys.
    const aiColourDetectorSecret = new secretsmanager.Secret(
      this,
      'AiColourDetectorSecret',
      {
        secretName: `wardrobe/${stage}/gemini-colour`,
        description:
          'Gemini colour-detection credentials. Replace the generated value with a Gemini API key, or JSON { "apiKey", "model", "endpoint" }. Never commit the real key.',
        removalPolicy,
      },
    );
    // OpenAI credentials for outfit recommendations (WARDROBE-28).
    // Replace the generated placeholder after deploy. Never commit AI keys.
    const recommenderStrategy = resolveRecommenderStrategy(this);
    const aiRecommenderSecret = new secretsmanager.Secret(this, 'AiRecommenderSecret', {
      secretName: `wardrobe/${stage}/ai-recommender`,
      description:
        'OpenAI outfit-recommender credentials. Store a raw API key, or JSON { "apiKey", "model?", "endpoint?" }. Used when RECOMMENDER_STRATEGY=openai. Never commit AI keys.',
      removalPolicy,
    });
    // Placeholder only — replace after deploy. Never commit the Gemini key.
    const tryOnSecret = new secretsmanager.Secret(this, 'GeminiTryOnSecret', {
      secretName: tryOnSecretName(stage),
      description:
        'Gemini virtual try-on / outfit-render credentials. Replace the generated value with a Gemini API key, or JSON { "apiKey", "model", "endpoint" }. Never commit the real key.',
      removalPolicy,
    });
    const geminiTryOnModel =
      (this.node.tryGetContext('geminiTryOnModel') as string | undefined) ??
      process.env.GEMINI_TRY_ON_MODEL ??
      '';
    const geminiTryOnEndpoint =
      (this.node.tryGetContext('geminiTryOnEndpoint') as string | undefined) ??
      process.env.GEMINI_TRY_ON_ENDPOINT ??
      '';
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
    const meFn = this.lambda('MeFn', 'me', {
      ...commonLambdaProps,
      // Wipe can list/delete many Dynamo rows and S3 objects under users/{uid}/.
      timeout: cdk.Duration.seconds(29),
    });
    const wardrobesFn = this.lambda('WardrobesFn', 'wardrobes', commonLambdaProps);
    const itemsFn = this.lambda('ItemsFn', 'items', {
      ...commonLambdaProps,
      environment: {
        ...commonLambdaProps.environment,
        PROCESSING_QUEUE_URL: processingQueue.queueUrl,
      },
    });
    const outfitsFn = this.lambda('OutfitsFn', 'outfits', {
      ...commonLambdaProps,
      environment: {
        ...commonLambdaProps.environment,
        TRY_ON_QUEUE_URL: tryOnQueue.queueUrl,
      },
    });
    const recommendationsFn = this.lambda('RecommendationsFn', 'recommendations', {
      ...commonLambdaProps,
      // OpenAI chat + rule-based fallback needs headroom beyond the 10s default.
      timeout: cdk.Duration.seconds(15),
      environment: {
        ...commonLambdaProps.environment,
        RECOMMENDER_STRATEGY: recommenderStrategy,
        AI_RECOMMENDER_SECRET_ARN: aiRecommenderSecret.secretArn,
      },
    });
    const uploadsFn = this.lambda('UploadsFn', 'uploads', commonLambdaProps);
    // WARDROBE-43 CRUD + WARDROBE-44 PERSONAL reference-image presign/attach.
    // Try-on secret is granted to OutfitRenderFn only — not this Lambda.
    // PROCESS_AI_PROFILE is not enqueued here.
    const aiProfilesFn = this.lambda('AiProfilesFn', 'ai-profiles', commonLambdaProps);

    // WARDROBE-45: deploy-time seed of READY GENERIC_MODEL catalog rows.
    // Delete is a no-op so retained tables keep the picker IDs. Re-run the
    // CLI (`npm run seed:generic-models`) after changing images only.
    const genericModelSeedLogGroup = new logs.LogGroup(this, 'GenericModelSeedFnLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const genericModelSeedFn = new NodejsFunction(this, 'GenericModelSeedFn', {
      ...commonLambdaProps,
      timeout: cdk.Duration.seconds(30),
      entry: path.join(__dirname, '../src/functions/ai-profiles/seed-handler.ts'),
      handler: 'handler',
      logGroup: genericModelSeedLogGroup,
    });
    table.grantReadWriteData(genericModelSeedFn);

    const genericModelSeedProvider = new cr.Provider(this, 'GenericModelSeedProvider', {
      onEventHandler: genericModelSeedFn,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    new cdk.CustomResource(this, 'GenericModelCatalogSeed', {
      serviceToken: genericModelSeedProvider.serviceToken,
      properties: {
        CatalogVersion: GENERIC_MODEL_CATALOG_VERSION,
        TableName: table.tableName,
      },
    });

    const processingFn = this.lambda('ProcessingFn', 'processing', {
      ...commonLambdaProps,
      timeout: processingLambdaTimeout,
      memorySize: 512,
      environment: {
        ...commonLambdaProps.environment,
        PROCESSING_QUEUE_URL: processingQueue.queueUrl,
        BACKGROUND_REMOVAL_SECRET_ARN: backgroundRemovalSecret.secretArn,
        AI_CLASSIFIER_SECRET_ARN: aiClassifierSecret.secretArn,
        AI_COLOUR_DETECTOR_SECRET_ARN: aiColourDetectorSecret.secretArn,
        COLOUR_DETECTOR_STRATEGY: colourDetectorStrategy,
        ...(geminiModel ? { GEMINI_MODEL: geminiModel } : {}),
        ...(geminiEndpoint ? { GEMINI_ENDPOINT: geminiEndpoint } : {}),
        ...(geminiClassifierModel
          ? { GEMINI_CLASSIFIER_MODEL: geminiClassifierModel }
          : {}),
        ...(geminiClassifierEndpoint
          ? { GEMINI_CLASSIFIER_ENDPOINT: geminiClassifierEndpoint }
          : {}),
        ...(geminiColourModel ? { GEMINI_COLOUR_MODEL: geminiColourModel } : {}),
        ...(geminiColourEndpoint
          ? { GEMINI_COLOUR_ENDPOINT: geminiColourEndpoint }
          : {}),
      },
    });
    aiClassifierSecret.grantRead(processingFn);
    aiColourDetectorSecret.grantRead(processingFn);

    const outfitRenderFn = this.lambda('OutfitRenderFn', 'outfit-render', {
      ...commonLambdaProps,
      timeout: processingLambdaTimeout,
      memorySize: 512,
      environment: {
        ...commonLambdaProps.environment,
        TRY_ON_QUEUE_URL: tryOnQueue.queueUrl,
        GEMINI_TRY_ON_SECRET_ARN: tryOnSecret.secretArn,
        ...(geminiTryOnModel ? { GEMINI_TRY_ON_MODEL: geminiTryOnModel } : {}),
        ...(geminiTryOnEndpoint
          ? { GEMINI_TRY_ON_ENDPOINT: geminiTryOnEndpoint }
          : {}),
      },
    });

    table.grantReadWriteData(meFn);
    table.grantReadWriteData(wardrobesFn);
    table.grantReadWriteData(itemsFn);
    table.grantReadWriteData(outfitsFn);
    table.grantReadWriteData(aiProfilesFn);
    // Recommendations are derived and never persisted — read wardrobe + items only.
    table.grantReadData(recommendationsFn);
    aiRecommenderSecret.grantRead(recommendationsFn);
    // Worker reads the item then updates processingStatus / AI metadata.
    table.grant(processingFn, 'dynamodb:GetItem', 'dynamodb:UpdateItem');
    mediaBucket.grantPut(uploadsFn);
    // PERSONAL AI profile reference-image presign (WARDROBE-44).
    mediaBucket.grantPut(aiProfilesFn);
    // Account wipe lists and deletes objects under users/{uid}/ only.
    mediaBucket.grantRead(meFn);
    mediaBucket.grantDelete(meFn);
    // Read original images and write processed.png. No delete — keep originals.
    mediaBucket.grantRead(processingFn);
    mediaBucket.grantPut(processingFn);
    backgroundRemovalSecret.grantRead(processingFn);
    processingQueue.grantSendMessages(itemsFn);
    processingQueue.grantConsumeMessages(processingFn);
    // Try-on: outfits enqueue RENDER_OUTFIT; worker consumes + reads Gemini secret.
    tryOnQueue.grantSendMessages(outfitsFn);
    tryOnQueue.grantConsumeMessages(outfitRenderFn);
    tryOnSecret.grantRead(outfitRenderFn);
    // Worker reloads outfit, items, and READY profiles (PERSONAL + GSI1 GENERIC_MODEL).
    table.grantReadData(outfitRenderFn);
    table.grant(outfitRenderFn, 'dynamodb:UpdateItem');
    mediaBucket.grantRead(outfitRenderFn);
    mediaBucket.grantPut(outfitRenderFn);
    // Presigned GET for render.imageUrl on GET outfit / GET render.
    mediaBucket.grantRead(outfitsFn);

    processingFn.addEventSource(
      new SqsEventSource(processingQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );
    outfitRenderFn.addEventSource(
      new SqsEventSource(tryOnQueue, {
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

    new cloudwatch.Alarm(this, 'OutfitRenderDlqAlarm', {
      alarmName: `wardrobe-outfit-render-dlq-${stage}`,
      alarmDescription: 'Outfit render dead-letter queue contains messages',
      metric: tryOnDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'OutfitRenderQueueDepthAlarm', {
      alarmName: `wardrobe-outfit-render-depth-${stage}`,
      alarmDescription: 'Outfit render queue approximate depth is high',
      metric: tryOnQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
      }),
      threshold: 25,
      evaluationPeriods: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'OutfitRenderQueueOldestMessageAlarm', {
      alarmName: `wardrobe-outfit-render-oldest-${stage}`,
      alarmDescription: 'Oldest message in the outfit render queue exceeds age threshold',
      metric: tryOnQueue.metricApproximateAgeOfOldestMessage({
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
    const meIntegration = new HttpLambdaIntegration('MeIntegration', meFn);
    const wardrobesIntegration = new HttpLambdaIntegration('WardrobesIntegration', wardrobesFn);
    const itemsIntegration = new HttpLambdaIntegration('ItemsIntegration', itemsFn);
    const outfitsIntegration = new HttpLambdaIntegration('OutfitsIntegration', outfitsFn);
    const recommendationsIntegration = new HttpLambdaIntegration(
      'RecommendationsIntegration',
      recommendationsFn,
    );
    const uploadsIntegration = new HttpLambdaIntegration('UploadsIntegration', uploadsFn);
    const aiProfilesIntegration = new HttpLambdaIntegration(
      'AiProfilesIntegration',
      aiProfilesFn,
    );

    httpApi.addRoutes({
      path: '/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: healthIntegration,
    });

    httpApi.addRoutes({
      path: '/me/content',
      methods: [apigwv2.HttpMethod.DELETE],
      integration: meIntegration,
      authorizer: firebaseAuthorizer,
    });

    httpApi.addRoutes({
      path: '/me',
      methods: [apigwv2.HttpMethod.DELETE],
      integration: meIntegration,
      authorizer: firebaseAuthorizer,
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
      path: '/wardrobes/{wardrobeId}/outfits/{outfitId}/render',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: outfitsIntegration,
      authorizer: firebaseAuthorizer,
    });

    httpApi.addRoutes({
      path: '/wardrobes/{wardrobeId}/recommendations',
      methods: [apigwv2.HttpMethod.GET],
      integration: recommendationsIntegration,
      authorizer: firebaseAuthorizer,
    });

    httpApi.addRoutes({
      path: '/uploads',
      methods: [apigwv2.HttpMethod.POST],
      integration: uploadsIntegration,
      authorizer: firebaseAuthorizer,
    });

    httpApi.addRoutes({
      path: '/ai-profiles',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: aiProfilesIntegration,
      authorizer: firebaseAuthorizer,
    });

    httpApi.addRoutes({
      path: '/ai-profiles/models',
      methods: [apigwv2.HttpMethod.GET],
      integration: aiProfilesIntegration,
      authorizer: firebaseAuthorizer,
    });

    httpApi.addRoutes({
      path: '/ai-profiles/{aiProfileId}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.DELETE],
      integration: aiProfilesIntegration,
      authorizer: firebaseAuthorizer,
    });

    httpApi.addRoutes({
      path: '/ai-profiles/{aiProfileId}/uploads',
      methods: [apigwv2.HttpMethod.POST],
      integration: aiProfilesIntegration,
      authorizer: firebaseAuthorizer,
    });

    httpApi.addRoutes({
      path: '/ai-profiles/{aiProfileId}/reference-images',
      methods: [apigwv2.HttpMethod.POST],
      integration: aiProfilesIntegration,
      authorizer: firebaseAuthorizer,
    });

    // Isolated WARDROBE-38 module — see lib/support-mail.ts.
    addSupportMail(this, {
      stage,
      httpApi,
      authorizer: firebaseAuthorizer,
      commonLambdaProps,
      removalPolicy,
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

    new cdk.CfnOutput(this, 'OutfitRenderQueueUrl', {
      value: tryOnQueue.queueUrl,
      description: 'Outfit try-on / render queue URL',
    });

    new cdk.CfnOutput(this, 'GeminiTryOnSecretName', {
      value: tryOnSecret.secretName,
      description:
        'Secrets Manager secret for Gemini try-on credentials (API key, optional model/endpoint)',
    });

    new cdk.CfnOutput(this, 'FirebaseProjectIdSecretName', {
      value: firebaseProjectIdSecret.secretName,
      description: 'Secrets Manager secret that must contain the Firebase project ID',
    });

    new cdk.CfnOutput(this, 'BackgroundRemovalSecretName', {
      value: backgroundRemovalSecret.secretName,
      description:
        'Secrets Manager secret for Gemini background-removal credentials (API key, optional model/endpoint)',
    });

    new cdk.CfnOutput(this, 'AiClassifierSecretName', {
      value: aiClassifierSecret.secretName,
      description:
        'Secrets Manager secret for Gemini garment-classification credentials (API key, optional model/endpoint)',
    });

    new cdk.CfnOutput(this, 'AiColourDetectorSecretName', {
      value: aiColourDetectorSecret.secretName,
      description:
        'Secrets Manager secret for Gemini colour-detection credentials (API key, optional model/endpoint)',
    });

    new cdk.CfnOutput(this, 'AiRecommenderSecretName', {
      value: aiRecommenderSecret.secretName,
      description:
        'Secrets Manager secret for OpenAI outfit-recommender credentials (placeholder until replaced)',
    });

    new cdk.CfnOutput(this, 'GenericModelCatalogIds', {
      value: genericModelIds().join(','),
      description:
        'Stable GENERIC_MODEL aiProfileIds seeded for GET /ai-profiles/models (WARDROBE-45)',
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

function resolveRecommenderStrategy(node: Construct): string {
  const fromContext = node.node.tryGetContext('recommenderStrategy');
  const raw =
    (typeof fromContext === 'string' && fromContext.trim()
      ? fromContext
      : undefined) ??
    process.env.RECOMMENDER_STRATEGY?.trim() ??
    'openai';
  const normalized = raw.toLowerCase();
  if (normalized === 'http' || normalized === 'rules' || normalized === 'rule-based') {
    return normalized === 'rule-based' ? 'rules' : normalized;
  }
  return 'openai';
}
