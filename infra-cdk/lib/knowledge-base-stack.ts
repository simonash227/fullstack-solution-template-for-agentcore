import * as cdk from "aws-cdk-lib"
import * as s3 from "aws-cdk-lib/aws-s3"
import * as kms from "aws-cdk-lib/aws-kms"
import * as iam from "aws-cdk-lib/aws-iam"
import * as bedrock from "aws-cdk-lib/aws-bedrock"
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch"
import * as sns from "aws-cdk-lib/aws-sns"
import * as sns_subscriptions from "aws-cdk-lib/aws-sns-subscriptions"
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions"
import { Construct } from "constructs"
import { AppConfig } from "./utils/config-manager"

export interface KnowledgeBaseStackProps extends cdk.NestedStackProps {
  config: AppConfig
}

export class KnowledgeBaseStack extends cdk.NestedStack {
  public readonly documentsBucket: s3.Bucket
  public readonly documentsKey: kms.Key
  public readonly workspaceBucket: s3.Bucket
  public readonly workspaceKey: kms.Key
  public readonly opsBucket: s3.Bucket
  public readonly opsKey: kms.Key
  public readonly knowledgeBaseId: string
  public readonly knowledgeBaseArn: string
  public readonly dataSourceId: string

  constructor(scope: Construct, id: string, props: KnowledgeBaseStackProps) {
    super(scope, id, props)

    const { config } = props
    const bucketPrefix = config.stack_name_base.toLowerCase()

    // ─── Step 3a: Documents Bucket ───────────────────────────────────

    // Customer-managed KMS key for documents bucket encryption
    this.documentsKey = new kms.Key(this, "DocumentsKey", {
      alias: `${config.stack_name_base}-documents`,
      description: `KMS key for ${config.stack_name_base} documents bucket`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    // S3 documents bucket (bucket names must be lowercase)
    this.documentsBucket = new s3.Bucket(this, "DocumentsBucket", {
      bucketName: `${bucketPrefix}-documents-${this.account}`,
      encryptionKey: this.documentsKey,
      encryption: s3.BucketEncryption.KMS,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          allowedHeaders: ["*"],
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedOrigins: ["https://*.amplifyapp.com", "http://localhost:3000"],
          exposedHeaders: ["ETag"],
          maxAge: 3600,
        },
      ],
      lifecycleRules: [
        {
          noncurrentVersionTransitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
          noncurrentVersionExpiration: cdk.Duration.days(2555),
        },
      ],
    })

    // Note: DenyUnencryptedUploads policy removed — bucket default encryption (KMS)
    // handles this automatically. The explicit deny blocked presigned URL uploads
    // because browsers can't send x-amz-server-side-encryption headers.

    // ─── Workspace Bucket (agent workspace files — separate from client documents) ───

    this.workspaceKey = new kms.Key(this, "WorkspaceKey", {
      alias: `${config.stack_name_base}-workspace`,
      description: `KMS key for ${config.stack_name_base} workspace bucket`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    this.workspaceBucket = new s3.Bucket(this, "WorkspaceBucket", {
      bucketName: `${bucketPrefix}-workspace-${this.account}`,
      encryptionKey: this.workspaceKey,
      encryption: s3.BucketEncryption.KMS,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    // ─── Ops Bucket (Cognito backups, operational exports) ──────────

    this.opsKey = new kms.Key(this, "OpsKey", {
      alias: `${config.stack_name_base}-ops`,
      description: `KMS key for ${config.stack_name_base} ops bucket`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    this.opsBucket = new s3.Bucket(this, "OpsBucket", {
      bucketName: `${bucketPrefix}-ops-${this.account}`,
      encryptionKey: this.opsKey,
      encryption: s3.BucketEncryption.KMS,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
          expiration: cdk.Duration.days(2555),
        },
      ],
    })

    // ─── Step 3b: S3 Vectors + Knowledge Base ────────────────────────

    // S3 Vector Bucket (separate from the documents bucket — stores embeddings)
    const vectorBucket = new cdk.CfnResource(this, "VectorBucket", {
      type: "AWS::S3Vectors::VectorBucket",
      properties: {
        VectorBucketName: `${bucketPrefix}-vectors-${this.account}`,
        Tags: [
          { Key: "clientId", Value: config.stack_name_base },
          { Key: "ManagedBy", Value: "CDK" },
        ],
      },
    })

    // S3 Vector Index — Titan Embed Text v2 outputs 1024 dimensions
    const vectorIndex = new cdk.CfnResource(this, "VectorIndex", {
      type: "AWS::S3Vectors::Index",
      properties: {
        VectorBucketName: `${bucketPrefix}-vectors-${this.account}`,
        IndexName: `${bucketPrefix}-kb-index`,
        Dimension: 1024,
        DistanceMetric: "cosine",
        DataType: "float32",
      },
    })
    vectorIndex.addDependency(vectorBucket)

    // Derive ARNs from the vector bucket/index names
    const vectorBucketArn = `arn:aws:s3vectors:${this.region}:${this.account}:bucket/${bucketPrefix}-vectors-${this.account}`
    const vectorIndexArn = `${vectorBucketArn}/index/${bucketPrefix}-kb-index`

    // ─── IAM Role for Knowledge Base ─────────────────────────────────

    const kbRole = new iam.Role(this, "KnowledgeBaseRole", {
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com"),
      description: `Bedrock Knowledge Base role for ${config.stack_name_base}`,
    })

    // Condition to restrict to this account's KB resources
    const kbCondition = {
      StringEquals: {
        "aws:SourceAccount": this.account,
      },
    }

    // Permission: invoke embedding model
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "BedrockInvokeModel",
        effect: iam.Effect.ALLOW,
        actions: ["bedrock:InvokeModel"],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
        ],
      })
    )

    // Permission: list models (required by KB service)
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "BedrockListModels",
        effect: iam.Effect.ALLOW,
        actions: ["bedrock:ListFoundationModels", "bedrock:ListCustomModels"],
        resources: ["*"],
      })
    )

    // Permission: read documents from S3 data source
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "S3ListBucket",
        effect: iam.Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [this.documentsBucket.bucketArn],
        conditions: {
          StringEquals: { "aws:ResourceAccount": this.account },
        },
      })
    )
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "S3GetObject",
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetObject"],
        resources: [this.documentsBucket.arnForObjects("*")],
        conditions: {
          StringEquals: { "aws:ResourceAccount": this.account },
        },
      })
    )

    // Permission: decrypt documents bucket KMS key
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "KmsDecryptDocuments",
        effect: iam.Effect.ALLOW,
        actions: ["kms:Decrypt"],
        resources: [this.documentsKey.keyArn],
        conditions: {
          StringEquals: {
            "kms:ViaService": `s3.${this.region}.amazonaws.com`,
          },
        },
      })
    )

    // Permission: S3 Vectors read/write for the vector index
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "S3VectorsAccess",
        effect: iam.Effect.ALLOW,
        actions: [
          "s3vectors:PutVectors",
          "s3vectors:GetVectors",
          "s3vectors:DeleteVectors",
          "s3vectors:QueryVectors",
          "s3vectors:GetIndex",
        ],
        resources: [vectorIndexArn],
      })
    )

    // ─── Bedrock Knowledge Base ──────────────────────────────────────

    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, "KnowledgeBase", {
      name: `${config.stack_name_base}-kb`,
      roleArn: kbRole.roleArn,
      description: `Document knowledge base for ${config.stack_name_base}`,
      knowledgeBaseConfiguration: {
        type: "VECTOR",
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
        },
      },
      storageConfiguration: {
        type: "S3_VECTORS",
        s3VectorsConfiguration: {
          vectorBucketArn: vectorBucketArn,
          indexName: `${bucketPrefix}-kb-index`,
        },
      },
    })
    knowledgeBase.addDependency(vectorIndex)
    knowledgeBase.node.addDependency(kbRole)

    this.knowledgeBaseId = knowledgeBase.attrKnowledgeBaseId
    this.knowledgeBaseArn = knowledgeBase.attrKnowledgeBaseArn

    // ─── Data Source (S3 documents bucket) ───────────────────────────

    const dataSource = new bedrock.CfnDataSource(this, "DataSource", {
      knowledgeBaseId: this.knowledgeBaseId,
      name: `${config.stack_name_base}-documents`,
      description: `S3 documents data source for ${config.stack_name_base}`,
      dataSourceConfiguration: {
        type: "S3",
        s3Configuration: {
          bucketArn: this.documentsBucket.bucketArn,
        },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: "SEMANTIC",
          semanticChunkingConfiguration: {
            maxTokens: 300,
            bufferSize: 1,
            breakpointPercentileThreshold: 90,
          },
        },
      },
    })
    dataSource.addDependency(knowledgeBase)

    this.dataSourceId = dataSource.attrDataSourceId

    // ─── Outputs ─────────────────────────────────────────────────────

    new cdk.CfnOutput(this, "DocumentsBucketName", {
      value: this.documentsBucket.bucketName,
      description: "S3 documents bucket name",
      exportName: `${config.stack_name_base}-DocumentsBucket`,
    })

    new cdk.CfnOutput(this, "DocumentsBucketArn", {
      value: this.documentsBucket.bucketArn,
      description: "S3 documents bucket ARN",
    })

    new cdk.CfnOutput(this, "DocumentsKeyArn", {
      value: this.documentsKey.keyArn,
      description: "KMS key ARN for documents encryption",
    })

    new cdk.CfnOutput(this, "KnowledgeBaseId", {
      value: this.knowledgeBaseId,
      description: "Bedrock Knowledge Base ID",
      exportName: `${config.stack_name_base}-KnowledgeBaseId`,
    })

    new cdk.CfnOutput(this, "KnowledgeBaseArn", {
      value: this.knowledgeBaseArn,
      description: "Bedrock Knowledge Base ARN",
    })

    new cdk.CfnOutput(this, "DataSourceId", {
      value: this.dataSourceId,
      description: "Knowledge Base Data Source ID",
    })

    new cdk.CfnOutput(this, "VectorBucketArn", {
      value: vectorBucketArn,
      description: "S3 Vectors bucket ARN",
    })

    new cdk.CfnOutput(this, "WorkspaceBucketName", {
      value: this.workspaceBucket.bucketName,
      description: "S3 workspace bucket name",
      exportName: `${config.stack_name_base}-WorkspaceBucket`,
    })

    new cdk.CfnOutput(this, "WorkspaceKeyArn", {
      value: this.workspaceKey.keyArn,
      description: "KMS key ARN for workspace encryption",
    })

    new cdk.CfnOutput(this, "OpsBucketName", {
      value: this.opsBucket.bucketName,
      description: "S3 ops bucket name",
      exportName: `${config.stack_name_base}-OpsBucket`,
    })

    new cdk.CfnOutput(this, "OpsKeyArn", {
      value: this.opsKey.keyArn,
      description: "KMS key ARN for ops encryption",
    })

    // ─── Step 3c: CloudWatch alarm on KB ingestion failures ───────────

    if (config.admin_user_email) {
      const ingestionAlarmTopic = new sns.Topic(this, "IngestionAlarmTopic", {
        displayName: `${config.stack_name_base} KB Ingestion Failures`,
      })
      ingestionAlarmTopic.addSubscription(
        new sns_subscriptions.EmailSubscription(config.admin_user_email)
      )

      const ingestionFailureAlarm = new cloudwatch.Alarm(
        this,
        "IngestionFailureAlarm",
        {
          alarmName: `${config.stack_name_base}-kb-ingestion-failures`,
          alarmDescription:
            "Knowledge Base ingestion job failed — documents may be stale",
          metric: new cloudwatch.Metric({
            namespace: "AWS/Bedrock",
            metricName: "IngestionJobsFailed",
            dimensionsMap: {
              KnowledgeBaseId: this.knowledgeBaseId,
            },
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
          }),
          threshold: 1,
          evaluationPeriods: 1,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }
      )
      ingestionFailureAlarm.addAlarmAction(
        new cw_actions.SnsAction(ingestionAlarmTopic)
      )
    }
  }
}
