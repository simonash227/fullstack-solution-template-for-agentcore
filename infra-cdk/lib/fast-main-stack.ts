import * as cdk from "aws-cdk-lib"
import { Construct } from "constructs"
import { AppConfig } from "./utils/config-manager"

// Import nested stacks
import { BackendStack } from "./backend-stack"
import { AmplifyHostingStack } from "./amplify-hosting-stack"
import { CognitoStack } from "./cognito-stack"
import { KnowledgeBaseStack } from "./knowledge-base-stack"
import { ObservabilityStack } from "./observability-stack"

export interface FastAmplifyStackProps extends cdk.StackProps {
  config: AppConfig
}

export class FastMainStack extends cdk.Stack {
  public readonly amplifyHostingStack: AmplifyHostingStack
  public readonly backendStack: BackendStack
  public readonly cognitoStack: CognitoStack
  public readonly knowledgeBaseStack: KnowledgeBaseStack
  public readonly observabilityStack: ObservabilityStack

  constructor(scope: Construct, id: string, props: FastAmplifyStackProps) {
    const description =
      "Fullstack AgentCore Solution Template - Main Stack (v0.3.1) (uksb-v6dos0t5g8)"
    super(scope, id, { ...props, description })

    // Step 1: Create the Amplify stack to get the predictable domain
    this.amplifyHostingStack = new AmplifyHostingStack(this, `${id}-amplify`, {
      config: props.config,
    })

    this.cognitoStack = new CognitoStack(this, `${id}-cognito`, {
      config: props.config,
      callbackUrls: ["http://localhost:3000", this.amplifyHostingStack.amplifyUrl],
    })

    // Step 3: Knowledge Base stack (documents bucket + KB)
    // Created before backend so KB ID can be passed to Gateway
    this.knowledgeBaseStack = new KnowledgeBaseStack(this, `${id}-kb`, {
      config: props.config,
    })

    // Step 2: Create backend stack with the predictable Amplify URL and Cognito details
    this.backendStack = new BackendStack(this, `${id}-backend`, {
      config: props.config,
      userPoolId: this.cognitoStack.userPoolId,
      userPoolClientId: this.cognitoStack.userPoolClientId,
      userPoolDomain: this.cognitoStack.userPoolDomain,
      frontendUrl: this.amplifyHostingStack.amplifyUrl,
      knowledgeBaseId: this.knowledgeBaseStack.knowledgeBaseId,
      dataSourceId: this.knowledgeBaseStack.dataSourceId,
      documentsBucketArn: this.knowledgeBaseStack.documentsBucket.bucketArn,
      documentsBucketName: this.knowledgeBaseStack.documentsBucket.bucketName,
      documentsKeyArn: this.knowledgeBaseStack.documentsKey.keyArn,
    })

    // Step 5c/5d: Observability stack (CloudWatch dashboard + CloudTrail + Cognito backup + OAM link)
    this.observabilityStack = new ObservabilityStack(this, `${id}-observability`, {
      config: props.config,
      userPoolId: this.cognitoStack.userPoolId,
      backupBucketName: this.knowledgeBaseStack.documentsBucket.bucketName,
      backupBucketKeyArn: this.knowledgeBaseStack.documentsKey.keyArn,
      monitoringSinkArn: props.config.monitoring_sink_arn,
    })

    // Cost tagging — tag all constructs in this stack for per-client billing breakdown
    cdk.Tags.of(this).add("clientId", props.config.stack_name_base)

    // Outputs
    new cdk.CfnOutput(this, "AmplifyAppId", {
      value: this.amplifyHostingStack.amplifyApp.appId,
      description: "Amplify App ID - use this for manual deployment",
      exportName: `${props.config.stack_name_base}-AmplifyAppId`,
    })

    new cdk.CfnOutput(this, "CognitoUserPoolId", {
      value: this.cognitoStack.userPoolId,
      description: "Cognito User Pool ID",
      exportName: `${props.config.stack_name_base}-CognitoUserPoolId`,
    })

    new cdk.CfnOutput(this, "CognitoClientId", {
      value: this.cognitoStack.userPoolClientId,
      description: "Cognito User Pool Client ID",
      exportName: `${props.config.stack_name_base}-CognitoClientId`,
    })

    new cdk.CfnOutput(this, "CognitoDomain", {
      value: `${this.cognitoStack.userPoolDomain.domainName}.auth.${cdk.Aws.REGION}.amazoncognito.com`,
      description: "Cognito Domain for OAuth",
      exportName: `${props.config.stack_name_base}-CognitoDomain`,
    })

    new cdk.CfnOutput(this, "RuntimeArn", {
      value: this.backendStack.runtimeArn,
      description: "AgentCore Runtime ARN",
      exportName: `${props.config.stack_name_base}-RuntimeArn`,
    })

    new cdk.CfnOutput(this, "MemoryArn", {
      value: this.backendStack.memoryArn,
      description: "AgentCore Memory ARN",
      exportName: `${props.config.stack_name_base}-MemoryArn`,
    })

    new cdk.CfnOutput(this, "FeedbackApiUrl", {
      value: this.backendStack.feedbackApiUrl,
      description: "Feedback API Gateway URL",
      exportName: `${props.config.stack_name_base}-FeedbackApiUrl`,
    })

    if (this.backendStack.documentsApiUrl) {
      new cdk.CfnOutput(this, "DocumentsApiUrl", {
        value: this.backendStack.documentsApiUrl,
        description: "Documents API Gateway URL",
        exportName: `${props.config.stack_name_base}-DocumentsApiUrl`,
      })
    }

    new cdk.CfnOutput(this, "AmplifyConsoleUrl", {
      value: `https://console.aws.amazon.com/amplify/apps/${this.amplifyHostingStack.amplifyApp.appId}`,
      description: "Amplify Console URL for monitoring deployments",
    })

    new cdk.CfnOutput(this, "AmplifyUrl", {
      value: this.amplifyHostingStack.amplifyUrl,
      description: "Amplify Frontend URL (available after deployment)",
    })

    new cdk.CfnOutput(this, "StagingBucketName", {
      value: this.amplifyHostingStack.stagingBucket.bucketName,
      description: "S3 bucket for Amplify deployment staging",
      exportName: `${props.config.stack_name_base}-StagingBucket`,
    })
  }
}
