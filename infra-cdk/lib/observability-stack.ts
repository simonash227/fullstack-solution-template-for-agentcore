import * as cdk from "aws-cdk-lib"
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch"
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail"
import * as events from "aws-cdk-lib/aws-events"
import * as events_targets from "aws-cdk-lib/aws-events-targets"
import * as iam from "aws-cdk-lib/aws-iam"
import * as kms from "aws-cdk-lib/aws-kms"
import * as lambda from "aws-cdk-lib/aws-lambda"
import * as logs from "aws-cdk-lib/aws-logs"
import * as s3 from "aws-cdk-lib/aws-s3"
import { PythonFunction } from "@aws-cdk/aws-lambda-python-alpha"
import { Construct } from "constructs"
import { AppConfig } from "./utils/config-manager"
import * as path from "path"

export interface ObservabilityStackProps extends cdk.NestedStackProps {
  config: AppConfig
  userPoolId: string
  backupBucketName: string
  backupBucketKeyArn: string
}

export class ObservabilityStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props)

    const config = props.config

    // ─── CloudTrail ────────────────────────────────────────────────────
    // Records every API call in the client's AWS account.
    // Professional services clients will ask "who accessed my data?" —
    // CloudTrail is the answer. Also proves Simon's IAM policy held.

    const trailBucket = new s3.Bucket(this, "CloudTrailBucket", {
      bucketName: `${config.stack_name_base.toLowerCase()}-cloudtrail-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: "archive-to-glacier",
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
          expiration: cdk.Duration.days(2555), // ~7 years
        },
      ],
    })

    new cloudtrail.Trail(this, "AuditTrail", {
      trailName: `${config.stack_name_base}-audit-trail`,
      bucket: trailBucket,
      includeGlobalServiceEvents: true,
      isMultiRegionTrail: false,
      enableFileValidation: true,
      sendToCloudWatchLogs: true,
      cloudWatchLogGroup: new logs.LogGroup(this, "CloudTrailLogGroup", {
        logGroupName: `/aws/cloudtrail/${config.stack_name_base}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    // ─── CloudWatch Dashboard ──────────────────────────────────────────
    // Surfaces AgentCore Runtime metrics into a named dashboard.
    // Namespace: bedrock-agentcore (emitted automatically by the Runtime).

    const dashboard = new cloudwatch.Dashboard(this, "AgentDashboard", {
      dashboardName: `${config.stack_name_base}-agent-dashboard`,
    })

    // Row 1: Invocation metrics
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Agent Invocations",
        left: [
          new cloudwatch.Metric({
            namespace: "bedrock-agentcore",
            metricName: "InvocationCount",
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
            dimensionsMap: { StackName: config.stack_name_base },
          }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "Invocation Errors",
        left: [
          new cloudwatch.Metric({
            namespace: "bedrock-agentcore",
            metricName: "InvocationErrors",
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
            dimensionsMap: { StackName: config.stack_name_base },
          }),
        ],
        width: 12,
      })
    )

    // Row 2: Latency and token usage
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Invocation Latency (p50 / p90 / p99)",
        left: [
          new cloudwatch.Metric({
            namespace: "bedrock-agentcore",
            metricName: "InvocationLatency",
            statistic: "p50",
            period: cdk.Duration.minutes(5),
            dimensionsMap: { StackName: config.stack_name_base },
          }),
          new cloudwatch.Metric({
            namespace: "bedrock-agentcore",
            metricName: "InvocationLatency",
            statistic: "p90",
            period: cdk.Duration.minutes(5),
            dimensionsMap: { StackName: config.stack_name_base },
          }),
          new cloudwatch.Metric({
            namespace: "bedrock-agentcore",
            metricName: "InvocationLatency",
            statistic: "p99",
            period: cdk.Duration.minutes(5),
            dimensionsMap: { StackName: config.stack_name_base },
          }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "Token Usage (Input / Output)",
        left: [
          new cloudwatch.Metric({
            namespace: "bedrock-agentcore",
            metricName: "InputTokens",
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
            dimensionsMap: { StackName: config.stack_name_base },
          }),
          new cloudwatch.Metric({
            namespace: "bedrock-agentcore",
            metricName: "OutputTokens",
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
            dimensionsMap: { StackName: config.stack_name_base },
          }),
        ],
        width: 12,
      })
    )

    // Row 3: Tool call metrics
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Tool Call Latency",
        left: [
          new cloudwatch.Metric({
            namespace: "bedrock-agentcore",
            metricName: "ToolCallLatency",
            statistic: "Average",
            period: cdk.Duration.minutes(5),
            dimensionsMap: { StackName: config.stack_name_base },
          }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "Active Sessions",
        left: [
          new cloudwatch.Metric({
            namespace: "bedrock-agentcore",
            metricName: "ActiveSessions",
            statistic: "Maximum",
            period: cdk.Duration.minutes(5),
            dimensionsMap: { StackName: config.stack_name_base },
          }),
        ],
        width: 12,
      })
    )

    // ─── Cognito User Pool Backup (Step 5d) ───────────────────────────
    // Weekly backup of all Cognito users to S3. Cognito has no native
    // backup — a deleted user pool means recreating all users manually.

    const backupBucket = s3.Bucket.fromBucketName(this, "BackupBucket", props.backupBucketName)
    const backupKey = kms.Key.fromKeyArn(this, "BackupKey", props.backupBucketKeyArn)

    const cognitoBackupLambda = new PythonFunction(this, "CognitoBackupLambda", {
      functionName: `${config.stack_name_base}-cognito-backup`,
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, "..", "lambdas", "cognito-backup"),
      handler: "handler",
      environment: {
        USER_POOL_ID: props.userPoolId,
        BACKUP_BUCKET: props.backupBucketName,
        KMS_KEY_ARN: props.backupBucketKeyArn,
        STACK_NAME: config.stack_name_base,
      },
      timeout: cdk.Duration.minutes(2),
      logGroup: new logs.LogGroup(this, "CognitoBackupLogGroup", {
        logGroupName: `/aws/lambda/${config.stack_name_base}-cognito-backup`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    // Grant permissions
    backupBucket.grantPut(cognitoBackupLambda)
    backupKey.grantEncrypt(cognitoBackupLambda)

    cognitoBackupLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:ListUsers"],
        resources: [
          `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${props.userPoolId}`,
        ],
      })
    )

    cognitoBackupLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: {
          StringEquals: { "cloudwatch:namespace": "AgentCore/Operations" },
        },
      })
    )

    // Schedule: every Sunday at 02:00 UTC
    new events.Rule(this, "CognitoBackupSchedule", {
      ruleName: `${config.stack_name_base}-cognito-backup-weekly`,
      schedule: events.Schedule.cron({ minute: "0", hour: "2", weekDay: "SUN" }),
      targets: [new events_targets.LambdaFunction(cognitoBackupLambda)],
    })

    // ─── Cognito Backup Alarm ─────────────────────────────────────────
    // Alert if the weekly backup fails (metric = 0 means failure)
    const backupFailureAlarm = new cloudwatch.Alarm(this, "CognitoBackupFailureAlarm", {
      alarmName: `${config.stack_name_base}-cognito-backup-failure`,
      metric: new cloudwatch.Metric({
        namespace: "AgentCore/Operations",
        metricName: "CognitoBackupSuccess",
        statistic: "Minimum",
        period: cdk.Duration.days(1),
        dimensionsMap: { StackName: config.stack_name_base },
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: "Cognito user pool backup failed or did not run",
    })

    // Row 4: Lambda metrics for feedback and documents APIs
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Lambda Errors (Feedback + Documents)",
        left: [
          new cloudwatch.Metric({
            namespace: "AWS/Lambda",
            metricName: "Errors",
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
            dimensionsMap: { FunctionName: `${config.stack_name_base}-feedback` },
          }),
          new cloudwatch.Metric({
            namespace: "AWS/Lambda",
            metricName: "Errors",
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
            dimensionsMap: { FunctionName: `${config.stack_name_base}-documents` },
          }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "API Gateway 4xx / 5xx",
        left: [
          new cloudwatch.Metric({
            namespace: "AWS/ApiGateway",
            metricName: "4XXError",
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
            dimensionsMap: { ApiName: `${config.stack_name_base}-api` },
          }),
          new cloudwatch.Metric({
            namespace: "AWS/ApiGateway",
            metricName: "5XXError",
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
            dimensionsMap: { ApiName: `${config.stack_name_base}-api` },
          }),
        ],
        width: 12,
      })
    )
  }
}
