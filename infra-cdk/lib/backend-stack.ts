import * as cdk from "aws-cdk-lib"
import * as cognito from "aws-cdk-lib/aws-cognito"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as iam from "aws-cdk-lib/aws-iam"
import * as ssm from "aws-cdk-lib/aws-ssm"
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager"
import * as dynamodb from "aws-cdk-lib/aws-dynamodb"
import * as apigateway from "aws-cdk-lib/aws-apigateway"
import * as logs from "aws-cdk-lib/aws-logs"
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch"
import * as s3 from "aws-cdk-lib/aws-s3"
import * as agentcore from "@aws-cdk/aws-bedrock-agentcore-alpha"
import * as bedrockagentcore from "aws-cdk-lib/aws-bedrockagentcore"
import { PythonFunction } from "@aws-cdk/aws-lambda-python-alpha"
import * as lambda from "aws-cdk-lib/aws-lambda"
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets"
import * as cr from "aws-cdk-lib/custom-resources"
import { Construct } from "constructs"
import { AppConfig } from "./utils/config-manager"
import { AgentCoreRole } from "./utils/agentcore-role"
import * as path from "path"
import * as fs from "fs"

export interface BackendStackProps extends cdk.NestedStackProps {
  config: AppConfig
  userPoolId: string
  userPoolClientId: string
  userPoolDomain: cognito.UserPoolDomain
  frontendUrl: string
  knowledgeBaseId?: string
  dataSourceId?: string
  documentsBucketArn?: string
  documentsBucketName?: string
  documentsKeyArn?: string
  workspaceBucketArn?: string
  workspaceBucketName?: string
  workspaceKeyArn?: string
}

export class BackendStack extends cdk.NestedStack {
  public readonly userPoolId: string
  public readonly userPoolClientId: string
  public readonly userPoolDomain: cognito.UserPoolDomain
  public feedbackApiUrl: string
  public documentsApiUrl: string
  public auditApiUrl: string
  public runtimeArn: string
  public memoryArn: string
  private agentName: cdk.CfnParameter
  private userPool: cognito.IUserPool
  private machineClient: cognito.UserPoolClient
  private machineClientSecret: secretsmanager.Secret
  private runtimeCredentialProvider: cdk.CustomResource
  private agentRuntime: agentcore.Runtime
  private agentRole: iam.IRole
  private restApi: apigateway.RestApi
  private documentsBucketName?: string
  private documentsKeyArn?: string
  private workspaceBucketName?: string
  private workspaceKeyArn?: string

  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props)

    // Store for use in private methods
    this.documentsBucketName = props.documentsBucketName
    this.documentsKeyArn = props.documentsKeyArn
    this.workspaceBucketName = props.workspaceBucketName
    this.workspaceKeyArn = props.workspaceKeyArn

    // Store the Cognito values
    this.userPoolId = props.userPoolId
    this.userPoolClientId = props.userPoolClientId
    this.userPoolDomain = props.userPoolDomain

    // Import the Cognito resources from the other stack
    this.userPool = cognito.UserPool.fromUserPoolId(
      this,
      "ImportedUserPoolForBackend",
      props.userPoolId
    )
    // then create the user pool client
    cognito.UserPoolClient.fromUserPoolClientId(
      this,
      "ImportedUserPoolClient",
      props.userPoolClientId
    )

    // Create Machine-to-Machine authentication components
    this.createMachineAuthentication(props.config)

    // DEPLOYMENT ORDER EXPLANATION:
    // 1. Cognito User Pool & Client (created in separate CognitoStack)
    // 2. Machine Client & Resource Server (created above for M2M auth)
    // 3. AgentCore Gateway (created next - uses machine client for auth)
    // 4. AgentCore Runtime (created last - independent of gateway)
    //
    // This order ensures that authentication components are available before
    // the gateway that depends on them, while keeping the runtime separate
    // since it doesn't directly depend on the gateway.

    // Create AgentCore Gateway (before Runtime)
    this.createAgentCoreGateway(props.config, props.knowledgeBaseId)

    // Create AgentCore Runtime resources
    this.createAgentCoreRuntime(props.config)

    // Store runtime ARN in SSM for frontend stack
    this.createRuntimeSSMParameters(props.config)

    // Store Cognito configuration in SSM for testing and frontend
    this.createCognitoSSMParameters(props.config)

    // Create Audit DynamoDB table (Step 5a — compliance audit trail)
    const auditTable = this.createAuditTable(props.config)

    // Grant agent runtime role write access to audit table (Step 5b)
    auditTable.grantWriteData(this.agentRole)

    // Create Feedback DynamoDB table (example of application data storage)
    const feedbackTable = this.createFeedbackTable(props.config)

    // Create API Gateway Feedback API resources (example of best-practice API Gateway + Lambda
    // pattern)
    this.createFeedbackApi(props.config, props.frontendUrl, feedbackTable)

    // Create Health endpoint (Step 5e — client health check)
    this.createHealthEndpoint(props.config, props.knowledgeBaseId)

    // Create Audit API (Step 7 — action log panel)
    this.createAuditApi(props.config, props.frontendUrl, auditTable)

    // Create Documents API (Step 3d — document management panel)
    if (props.documentsBucketArn && props.knowledgeBaseId && props.dataSourceId) {
      this.createDocumentsApi(props.config, props.frontendUrl, props)
    }

    // Create Knowledge API (Step 12c — "What I Know" page)
    if (props.workspaceBucketName) {
      this.createKnowledgeApi(props.config, props.frontendUrl)
    }

    // Create Workspace Admin API (admin workspace override management)
    if (props.workspaceBucketName) {
      this.createWorkspaceAdminApi(props.config, props.frontendUrl)
    }

    // Create Integrations Admin API (OAuth connection management)
    this.createIntegrationsApi(props.config, props.frontendUrl)

    // Create Transcribe API (Step 16a — voice-to-text presigned URL + batch transcription)
    if (props.config.client?.channels?.voiceToText?.enabled) {
      this.createTranscribeApi(props.config, props.frontendUrl)
    }

    // Create WhatsApp webhook (Step 16d — incoming messages + voice notes)
    if (props.config.client?.channels?.whatsapp?.enabled) {
      this.createWhatsAppWebhook(props.config, props.frontendUrl, auditTable)
    }
  }

  private createAgentCoreRuntime(config: AppConfig): void {
    const pattern = config.backend?.pattern || "strands-single-agent"

    // Parameters
    this.agentName = new cdk.CfnParameter(this, "AgentName", {
      type: "String",
      default: "StrandsAgent",
      description: "Name for the agent runtime",
    })

    const stack = cdk.Stack.of(this)
    const deploymentType = config.backend.deployment_type

    // Create the agent runtime artifact based on deployment type
    let agentRuntimeArtifact: agentcore.AgentRuntimeArtifact
    let zipPackagerResource: cdk.CustomResource | undefined

    if (deploymentType === "zip") {
      // ZIP DEPLOYMENT: Use Lambda to package and upload to S3 (no Docker required)
      const repoRoot = path.resolve(__dirname, "..", "..")
      const patternDir = path.join(repoRoot, "patterns", pattern)

      // Create S3 bucket for agent code
      const agentCodeBucket = new s3.Bucket(this, "AgentCodeBucket", {
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        versioned: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      })

      // Lambda to package agent code
      const packagerLambda = new lambda.Function(this, "ZipPackagerLambda", {
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: "index.handler",
        code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambdas", "zip-packager")),
        timeout: cdk.Duration.minutes(10),
        memorySize: 1024,
        ephemeralStorageSize: cdk.Size.gibibytes(2),
      })

      agentCodeBucket.grantReadWrite(packagerLambda)

      // Read agent code files and encode as base64
      const agentCode: Record<string, string> = {}
      
      // Read pattern .py files
      for (const file of fs.readdirSync(patternDir)) {
        if (file.endsWith(".py")) {
          const content = fs.readFileSync(path.join(patternDir, file))
          agentCode[file] = content.toString("base64")
        }
      }

      // Read shared modules (gateway/, tools/)
      for (const module of ["gateway", "tools"]) {
        const moduleDir = path.join(repoRoot, module)
        if (fs.existsSync(moduleDir)) {
          this.readDirRecursive(moduleDir, module, agentCode)
        }
      }

      // Read requirements
      const requirementsPath = path.join(patternDir, "requirements.txt")
      const requirements = fs.readFileSync(requirementsPath, "utf-8")
        .split("\n")
        .map(line => line.trim())
        .filter(line => line && !line.startsWith("#"))

      // Create hash for change detection
      // We use this to trigger update when content changes
      const contentHash = this.hashContent(JSON.stringify({ requirements, agentCode }))

      // Custom Resource to trigger packaging
      const provider = new cr.Provider(this, "ZipPackagerProvider", {
        onEventHandler: packagerLambda,
      })

      zipPackagerResource = new cdk.CustomResource(this, "ZipPackager", {
        serviceToken: provider.serviceToken,
        properties: {
          BucketName: agentCodeBucket.bucketName,
          ObjectKey: "deployment_package.zip",
          Requirements: requirements,
          AgentCode: agentCode,
          ContentHash: contentHash,
        },
      })

      // Store bucket name in SSM for updates
      new ssm.StringParameter(this, "AgentCodeBucketNameParam", {
        parameterName: `/${config.stack_name_base}/agent-code-bucket`,
        stringValue: agentCodeBucket.bucketName,
        description: "S3 bucket for agent code deployment packages",
      })

      agentRuntimeArtifact = agentcore.AgentRuntimeArtifact.fromS3(
        {
          bucketName: agentCodeBucket.bucketName,
          objectKey: "deployment_package.zip",
        },
        agentcore.AgentCoreRuntime.PYTHON_3_12,
        ["opentelemetry-instrument", "basic_agent.py"]
      )
    } else {
      // DOCKER DEPLOYMENT: Use container-based deployment
      agentRuntimeArtifact = agentcore.AgentRuntimeArtifact.fromAsset(
        path.resolve(__dirname, "..", ".."),
        {
          platform: ecr_assets.Platform.LINUX_ARM64,
          file: `patterns/${pattern}/Dockerfile`,
        }
      )
    }

    // Configure network mode based on config.yaml settings.
    // PUBLIC: Runtime is accessible over the public internet (default).
    // VPC: Runtime is deployed into a user-provided VPC for private network isolation.
    //      The user must ensure their VPC has the necessary VPC endpoints for AWS services.
    //      See docs/DEPLOYMENT.md for the full list of required VPC endpoints.
    const networkConfiguration = this.buildNetworkConfiguration(config)

    // Configure JWT authorizer with Cognito
    const authorizerConfiguration = agentcore.RuntimeAuthorizerConfiguration.usingJWT(
      `https://cognito-idp.${stack.region}.amazonaws.com/${this.userPoolId}/.well-known/openid-configuration`,
      [this.userPoolClientId, this.machineClient.userPoolClientId]
    )

    // Create AgentCore execution role
    const agentRole = new AgentCoreRole(this, "AgentCoreRole")
    this.agentRole = agentRole

    // Create memory resource with short-term + long-term strategies
    // Short-term: conversation history (automatic). Long-term: summaries, preferences, facts.
    const memory = new cdk.CfnResource(this, "AgentMemory", {
      type: "AWS::BedrockAgentCore::Memory",
      properties: {
        Name: cdk.Names.uniqueResourceName(this, { maxLength: 48 }),
        EventExpiryDuration: 365,
        Description: `Agent memory for ${config.stack_name_base} with long-term strategies`,
        MemoryStrategies: [
          {
            SummaryMemoryStrategy: {
              Name: "SessionSummarizer",
              Description: "Auto-summarises each conversation session",
              Namespaces: ["/summaries/{actorId}/{sessionId}"],
            },
          },
          {
            UserPreferenceMemoryStrategy: {
              Name: "PreferenceLearner",
              Description: "Learns user communication and workflow preferences",
              Namespaces: ["/preferences/{actorId}"],
            },
          },
          {
            SemanticMemoryStrategy: {
              Name: "FactExtractor",
              Description: "Extracts key facts, entities, and decisions",
              Namespaces: ["/facts/{actorId}"],
            },
          },
        ],
        MemoryExecutionRoleArn: agentRole.roleArn,
        Tags: {
          Name: `${config.stack_name_base}_Memory`,
          ManagedBy: "CDK",
        },
      },
    })
    // TEMP: Hardcoded after out-of-band memory delete/recreate. Remove once CFn state is clean.
    const memoryId = "FASTstackFASTstackbackend82B4A665-MNVG0kBRke"
    const memoryArn = `arn:aws:bedrock-agentcore:${stack.region}:${stack.account}:memory/${memoryId}`

    // Store the memory ARN for access from main stack
    this.memoryArn = memoryArn

    // Add memory-specific permissions to agent role
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "MemoryResourceAccess",
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock-agentcore:CreateEvent",
          "bedrock-agentcore:GetEvent",
          "bedrock-agentcore:ListEvents",
          "bedrock-agentcore:RetrieveMemoryRecords", // Only needed for long-term strategies
        ],
        resources: [memoryArn],
      })
    )

    // Add SSM permissions for AgentCore Gateway URL lookup
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "SSMParameterAccess",
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/${config.stack_name_base}/*`,
        ],
      })
    )

    // Add S3 read access for workspace files (system prompt assembly at runtime start)
    if (this.workspaceBucketName) {
      agentRole.addToPolicy(
        new iam.PolicyStatement({
          sid: "WorkspacePromptRead",
          effect: iam.Effect.ALLOW,
          actions: ["s3:GetObject"],
          resources: [
            `arn:aws:s3:::${this.workspaceBucketName}/base-persona.md`,
            `arn:aws:s3:::${this.workspaceBucketName}/map.md`,
            `arn:aws:s3:::${this.workspaceBucketName}/overrides/base-persona.md`,
            `arn:aws:s3:::${this.workspaceBucketName}/overrides/map.md`,
            `arn:aws:s3:::${this.workspaceBucketName}/domains/*`,
            `arn:aws:s3:::${this.workspaceBucketName}/overrides/domains/*`,
          ],
        })
      )
      // List domain files for dynamic domain catalog at agent init
      agentRole.addToPolicy(
        new iam.PolicyStatement({
          sid: "WorkspaceDomainList",
          effect: iam.Effect.ALLOW,
          actions: ["s3:ListBucket"],
          resources: [`arn:aws:s3:::${this.workspaceBucketName}`],
          conditions: {
            StringLike: { "s3:prefix": ["domains/*", "overrides/domains/*"] },
          },
        })
      )
      if (this.workspaceKeyArn) {
        agentRole.addToPolicy(
          new iam.PolicyStatement({
            sid: "WorkspacePromptKMS",
            effect: iam.Effect.ALLOW,
            actions: ["kms:Decrypt"],
            resources: [this.workspaceKeyArn],
          })
        )
      }
    }

    // Add Code Interpreter permissions
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "CodeInterpreterAccess",
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock-agentcore:StartCodeInterpreterSession",
          "bedrock-agentcore:StopCodeInterpreterSession",
          "bedrock-agentcore:InvokeCodeInterpreter",
        ],
        resources: [`arn:aws:bedrock-agentcore:${this.region}:aws:code-interpreter/*`],
      })
    )

    // Add OAuth2 Credential Provider access for AgentCore Runtime
    // The @requires_access_token decorator performs a two-stage process:
    // 1. GetOauth2CredentialProvider - Looks up provider metadata (ARN, vendor config, grant types)
    // 2. GetResourceOauth2Token - Uses metadata to fetch the actual access token from Token Vault
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "OAuth2CredentialProviderAccess",
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock-agentcore:GetOauth2CredentialProvider",
          "bedrock-agentcore:GetResourceOauth2Token",
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:oauth2-credential-provider/*`,
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:token-vault/*`,
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/*`,
        ],
      })
    )

    // Add Secrets Manager access for OAuth2
    // AgentCore Runtime needs to read two secrets:
    // 1. Machine client secret (created by CDK)
    // 2. Token Vault OAuth2 secret (created by AgentCore Identity)
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "SecretsManagerOAuth2Access",
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/${config.stack_name_base}/machine_client_secret*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:bedrock-agentcore-identity!default/oauth2/${config.stack_name_base}-runtime-gateway-auth*`,
        ],
      })
    )

    // Environment variables for the runtime
    const envVars: { [key: string]: string } = {
      AWS_REGION: stack.region,
      AWS_DEFAULT_REGION: stack.region,
      MEMORY_ID: memoryId,
      STACK_NAME: config.stack_name_base,
      GATEWAY_CREDENTIAL_PROVIDER_NAME: `${config.stack_name_base}-runtime-gateway-auth`, // Used by @requires_access_token decorator to look up the correct provider
      AUDIT_TABLE_NAME: `${config.stack_name_base}-audit`, // Step 5b: DynamoDB audit table for tool call logging
      WORKSPACE_BUCKET: this.workspaceBucketName || "", // Step 12c: workspace files in dedicated workspace bucket
      WORKSPACE_PREFIX: "", // Workspace files at bucket root (no prefix needed — dedicated bucket)
      AGENT_NAME: config.client?.branding?.agentName || "Assistant", // Step 13a: from client-config.json
      FIRM_NAME: config.client?.branding?.firmName || "the firm", // Step 13a: from client-config.json
    }

    // Create the runtime using L2 construct
    // requestHeaderConfiguration allows the agent to read the Authorization header
    // from RequestContext.request_headers, which is needed to securely extract the
    // user ID from the validated JWT token (sub claim) instead of trusting the payload body.
    this.agentRuntime = new agentcore.Runtime(this, "Runtime", {
      runtimeName: `${config.stack_name_base.replace(/-/g, "_")}_${this.agentName.valueAsString}`,
      agentRuntimeArtifact: agentRuntimeArtifact,
      executionRole: agentRole,
      networkConfiguration: networkConfiguration,
      protocolConfiguration: agentcore.ProtocolType.HTTP,
      environmentVariables: envVars,
      authorizerConfiguration: authorizerConfiguration,
      requestHeaderConfiguration: {
        allowlistedHeaders: ["Authorization"],
      },
      description: `${pattern} agent runtime for ${config.stack_name_base}`,
    })

    // Make sure that ZIP is uploaded before Runtime is created
    if (zipPackagerResource) {
      this.agentRuntime.node.addDependency(zipPackagerResource)
    }

    // Store the runtime ARN
    this.runtimeArn = this.agentRuntime.agentRuntimeArn

    // Outputs
    new cdk.CfnOutput(this, "AgentRuntimeId", {
      description: "ID of the created agent runtime",
      value: this.agentRuntime.agentRuntimeId,
    })

    new cdk.CfnOutput(this, "AgentRuntimeArn", {
      description: "ARN of the created agent runtime",
      value: this.agentRuntime.agentRuntimeArn,
      exportName: `${config.stack_name_base}-AgentRuntimeArn`,
    })

    new cdk.CfnOutput(this, "AgentRoleArn", {
      description: "ARN of the agent execution role",
      value: agentRole.roleArn,
    })

    // Memory ARN output
    new cdk.CfnOutput(this, "MemoryArn", {
      description: "ARN of the agent memory resource",
      value: memoryArn,
    })
  }

  private createRuntimeSSMParameters(config: AppConfig): void {
    // Store runtime ARN in SSM for frontend stack
    new ssm.StringParameter(this, "RuntimeArnParam", {
      parameterName: `/${config.stack_name_base}/runtime-arn`,
      stringValue: this.runtimeArn,
    })
  }

  private createCognitoSSMParameters(config: AppConfig): void {
    // Store Cognito configuration in SSM for testing and frontend access
    new ssm.StringParameter(this, "CognitoUserPoolIdParam", {
      parameterName: `/${config.stack_name_base}/cognito-user-pool-id`,
      stringValue: this.userPoolId,
      description: "Cognito User Pool ID",
    })

    new ssm.StringParameter(this, "CognitoUserPoolClientIdParam", {
      parameterName: `/${config.stack_name_base}/cognito-user-pool-client-id`,
      stringValue: this.userPoolClientId,
      description: "Cognito User Pool Client ID",
    })

    new ssm.StringParameter(this, "MachineClientIdParam", {
      parameterName: `/${config.stack_name_base}/machine_client_id`,
      stringValue: this.machineClient.userPoolClientId,
      description: "Machine Client ID for M2M authentication",
    })

    // Use the correct Cognito domain format from the passed domain
    new ssm.StringParameter(this, "CognitoDomainParam", {
      parameterName: `/${config.stack_name_base}/cognito_provider`,
      stringValue: `${this.userPoolDomain.domainName}.auth.${cdk.Aws.REGION}.amazoncognito.com`,
      description: "Cognito domain URL for token endpoint",
    })
  }

  // Creates a DynamoDB table for audit logging (Step 5a).
  // All tool calls, actions, and workflow events are logged here for compliance.
  // Professional services requirement: 7-year retention, PITR, RETAIN on delete.
  // Three GSIs defined at creation — DynamoDB cannot add GSIs to tables with data
  // without a full migration, so all three must exist from day one.
  private createAuditTable(config: AppConfig): dynamodb.Table {
    const auditTable = new dynamodb.Table(this, "AuditTable", {
      tableName: `${config.stack_name_base}-audit`,
      partitionKey: {
        name: "sessionId",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "timestamp",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "expiresAt",
    })

    // GSI 1: Query audit records by userId (for per-user audit view)
    auditTable.addGlobalSecondaryIndex({
      indexName: "userId-timestamp-index",
      partitionKey: {
        name: "userId",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "timestamp",
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    })

    // GSI 2: Query audit records by workflowId (for full workflow drill-down)
    auditTable.addGlobalSecondaryIndex({
      indexName: "workflowId-timestamp-index",
      partitionKey: {
        name: "workflowId",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "timestamp",
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    })

    // GSI 3: Query audit records by date prefix (for date range filtering)
    // datePrefix format: YYYY-MM-DD (written by the agent logging utility)
    auditTable.addGlobalSecondaryIndex({
      indexName: "datePrefix-timestamp-index",
      partitionKey: {
        name: "datePrefix",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "timestamp",
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    })

    return auditTable
  }

  // Creates a DynamoDB table for storing user feedback.
  private createFeedbackTable(config: AppConfig): dynamodb.Table {
    const feedbackTable = new dynamodb.Table(this, "FeedbackTable", {
      tableName: `${config.stack_name_base}-feedback`,
      partitionKey: {
        name: "feedbackId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    })

    // Add GSI for querying by feedbackType with timestamp sorting
    feedbackTable.addGlobalSecondaryIndex({
      indexName: "feedbackType-timestamp-index",
      partitionKey: {
        name: "feedbackType",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "timestamp",
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    })

    return feedbackTable
  }

  /**
   * Creates an API Gateway with Lambda integration for the feedback endpoint.
   * This is an EXAMPLE implementation demonstrating best practices for API Gateway + Lambda.
   *
   * API Contract - POST /feedback
   * Authorization: Bearer <cognito-access-token> (required)
   *
   * Request Body:
   *   sessionId: string (required, max 100 chars, alphanumeric with -_) - Conversation session ID
   *   message: string (required, max 5000 chars) - Agent's response being rated
   *   feedbackType: "positive" | "negative" (required) - User's rating
   *   comment: string (optional, max 5000 chars) - User's explanation for rating
   *
   * Success Response (200):
   *   { success: true, feedbackId: string }
   *
   * Error Responses:
   *   400: { error: string } - Validation failure (missing fields, invalid format)
   *   401: { error: "Unauthorized" } - Invalid/missing JWT token
   *   500: { error: "Internal server error" } - DynamoDB or processing error
   *
   * Implementation: infra-cdk/lambdas/feedback/index.py
   */
  private createFeedbackApi(
    config: AppConfig,
    frontendUrl: string,
    feedbackTable: dynamodb.Table
  ): void {
    // Create Lambda function for feedback using Python
    // ARM_64 required — matches Powertools ARM64 layer and avoids cross-platform
    const feedbackLambda = new PythonFunction(this, "FeedbackLambda", {
      functionName: `${config.stack_name_base}-feedback`,
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, "..", "lambdas", "feedback"),
      handler: "handler",
      environment: {
        TABLE_NAME: feedbackTable.tableName,
        CORS_ALLOWED_ORIGINS: `${frontendUrl},http://localhost:3000`,
      },
      timeout: cdk.Duration.seconds(30),
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(
          this,
          "PowertoolsLayer",
          `arn:aws:lambda:${
            cdk.Stack.of(this).region
          }:017000801446:layer:AWSLambdaPowertoolsPythonV3-python313-arm64:18`
        ),
      ],
      logGroup: new logs.LogGroup(this, "FeedbackLambdaLogGroup", {
        logGroupName: `/aws/lambda/${config.stack_name_base}-feedback`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    // Grant Lambda permissions to write to DynamoDB
    feedbackTable.grantWriteData(feedbackLambda)

    /*
     * CORS TODO: Wildcard (*) used because Backend deploys before Frontend in nested stack order.
     * For Lambda proxy integrations, the Lambda's ALLOWED_ORIGINS env var is the primary CORS control.
     * API Gateway defaultCorsPreflightOptions below only handles OPTIONS preflight requests.
     * See detailed explanation and fix options in: infra-cdk/lambdas/feedback/index.py
     */
    this.restApi = new apigateway.RestApi(this, "FeedbackApi", {
      restApiName: `${config.stack_name_base}-api`,
      description: "API for user feedback and future endpoints",
      defaultCorsPreflightOptions: {
        allowOrigins: [frontendUrl, "http://localhost:3000"],
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
      },
      deployOptions: {
        stageName: "prod",
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
        cachingEnabled: true,
        cacheClusterEnabled: true,
        cacheClusterSize: "0.5",
        cacheTtl: cdk.Duration.minutes(5),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        metricsEnabled: true,
        accessLogDestination: new apigateway.LogGroupLogDestination(
          new logs.LogGroup(this, "FeedbackApiAccessLogGroup", {
            logGroupName: `/aws/apigateway/${config.stack_name_base}-api-access`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          })
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        tracingEnabled: true,
        methodOptions: {
          // Disable caching for audit endpoint (query params vary per request)
          "/audit/GET": {
            cachingEnabled: false,
          },
          // Disable caching for health endpoint
          "/health/GET": {
            cachingEnabled: false,
          },
          // Disable caching for workspace admin endpoints (content changes on writes)
          "/workspace/GET": {
            cachingEnabled: false,
          },
          "/workspace/file/GET": {
            cachingEnabled: false,
          },
          "/workspace/file/PUT": {
            cachingEnabled: false,
          },
          "/workspace/file/DELETE": {
            cachingEnabled: false,
          },
          "/workspace/learned/GET": {
            cachingEnabled: false,
          },
          "/workspace/learned/PUT": {
            cachingEnabled: false,
          },
          "/workspace/learned/DELETE": {
            cachingEnabled: false,
          },
          // Disable caching for knowledge endpoints (content changes on writes)
          "/knowledge/GET": {
            cachingEnabled: false,
          },
          "/knowledge/{category}/GET": {
            cachingEnabled: false,
          },
          "/knowledge/{category}/POST": {
            cachingEnabled: false,
          },
          "/knowledge/{category}/{index}/GET": {
            cachingEnabled: false,
          },
          // Disable caching for transcribe presigned URL (unique per request)
          "/transcribe/presigned-url/GET": {
            cachingEnabled: false,
          },
          "/transcribe/audio/POST": {
            cachingEnabled: false,
          },
          // Disable caching for WhatsApp webhook (every request is unique)
          "/whatsapp/GET": {
            cachingEnabled: false,
          },
          "/whatsapp/POST": {
            cachingEnabled: false,
          },
          // Disable caching for integrations admin endpoints
          "/integrations/GET": {
            cachingEnabled: false,
          },
          "/integrations/{provider}/DELETE": {
            cachingEnabled: false,
          },
          "/integrations/{provider}/auth-url/GET": {
            cachingEnabled: false,
          },
          "/integrations/{provider}/callback/GET": {
            cachingEnabled: false,
          },
        },
      },
    })
    const api = this.restApi

    // Add request validator for API security
    const requestValidator = new apigateway.RequestValidator(this, "FeedbackApiRequestValidator", {
      restApi: api,
      requestValidatorName: `${config.stack_name_base}-request-validator`,
      validateRequestBody: true,
      validateRequestParameters: true,
    })

    // Create Cognito authorizer
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, "FeedbackApiAuthorizer", {
      cognitoUserPools: [this.userPool],
      identitySource: "method.request.header.Authorization",
      authorizerName: `${config.stack_name_base}-authorizer`,
    })

    // Create /feedback resource and POST method
    const feedbackResource = api.root.addResource("feedback")
    feedbackResource.addMethod("POST", new apigateway.LambdaIntegration(feedbackLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
      requestValidator: requestValidator,
    })

    // Store the API URL for access from main stack
    this.feedbackApiUrl = api.url

    // Store API URL in SSM for frontend
    new ssm.StringParameter(this, "FeedbackApiUrlParam", {
      parameterName: `/${config.stack_name_base}/feedback-api-url`,
      stringValue: api.url,
      description: "Feedback API Gateway URL",
    })
  }

  /**
   * Step 7: Audit API — query action log records for the Action Log panel.
   * Uses the existing REST API (shared with feedback/health) and adds a /audit GET route.
   */
  private createAuditApi(
    config: AppConfig,
    frontendUrl: string,
    auditTable: dynamodb.Table
  ): void {
    const auditLambda = new PythonFunction(this, "AuditLambda", {
      functionName: `${config.stack_name_base}-audit`,
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, "..", "lambdas", "audit"),
      handler: "handler",
      environment: {
        TABLE_NAME: auditTable.tableName,
        CORS_ALLOWED_ORIGINS: `${frontendUrl},http://localhost:3000`,
      },
      timeout: cdk.Duration.seconds(30),
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(
          this,
          "AuditPowertoolsLayer",
          `arn:aws:lambda:${
            cdk.Stack.of(this).region
          }:017000801446:layer:AWSLambdaPowertoolsPythonV3-python313-arm64:18`
        ),
      ],
      logGroup: new logs.LogGroup(this, "AuditLambdaLogGroup", {
        logGroupName: `/aws/lambda/${config.stack_name_base}-audit`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    // Grant read-only access to audit table
    auditTable.grantReadData(auditLambda)

    // Add /audit resource to the existing REST API with Cognito auth
    const auditAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "AuditApiAuthorizer",
      {
        cognitoUserPools: [this.userPool],
        identitySource: "method.request.header.Authorization",
        authorizerName: `${config.stack_name_base}-audit-authorizer`,
      }
    )

    const auditResource = this.restApi.root.addResource("audit")
    auditResource.addMethod(
      "GET",
      new apigateway.LambdaIntegration(auditLambda),
      {
        authorizer: auditAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      }
    )

    // The audit endpoint lives on the same API as feedback
    this.auditApiUrl = this.restApi.url
  }

  // Step 5e: Health endpoint — secured with API key, not Cognito.
  // Returns agent runtime status, KB status, and last ingestion timestamp.
  private createHealthEndpoint(
    config: AppConfig,
    knowledgeBaseId?: string
  ): void {
    const healthLambda = new PythonFunction(this, "HealthLambda", {
      functionName: `${config.stack_name_base}-health`,
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, "..", "lambdas", "health"),
      handler: "handler",
      environment: {
        RUNTIME_ARN: this.runtimeArn,
        KNOWLEDGE_BASE_ID: knowledgeBaseId || "",
        STACK_NAME: config.stack_name_base,
      },
      timeout: cdk.Duration.seconds(60),
      logGroup: new logs.LogGroup(this, "HealthLambdaLogGroup", {
        logGroupName: `/aws/lambda/${config.stack_name_base}-health`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    // Grant permissions to invoke the runtime and describe the knowledge base
    healthLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:GetAgentRuntime"],
        resources: [this.runtimeArn],
      })
    )

    if (knowledgeBaseId) {
      healthLambda.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            "bedrock:GetKnowledgeBase",
            "bedrock:ListDataSources",
            "bedrock:GetDataSource",
          ],
          resources: [
            `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/${knowledgeBaseId}`,
          ],
        })
      )
    }

    // API key for securing the health endpoint
    const apiKey = this.restApi.addApiKey("HealthApiKey", {
      apiKeyName: `${config.stack_name_base}-health-key`,
      description: "API key for health endpoint access",
    })

    const usagePlan = this.restApi.addUsagePlan("HealthUsagePlan", {
      name: `${config.stack_name_base}-health-plan`,
      throttle: { rateLimit: 10, burstLimit: 20 },
      apiStages: [{ api: this.restApi, stage: this.restApi.deploymentStage }],
    })
    usagePlan.addApiKey(apiKey)

    // Add /health resource with API key requirement
    const healthResource = this.restApi.root.addResource("health")
    healthResource.addMethod("GET", new apigateway.LambdaIntegration(healthLambda), {
      apiKeyRequired: true,
    })

    // Output the API key ID (value retrieved via CLI)
    new cdk.CfnOutput(cdk.Stack.of(this), "HealthApiKeyId", {
      value: apiKey.keyId,
      description: "Health endpoint API Key ID — retrieve value with: aws apigateway get-api-key --api-key <id> --include-value",
    })
  }

  /**
   * Step 3d: Documents API — list, upload (presigned), download (presigned), delete + KB re-sync.
   */
  private createDocumentsApi(
    config: AppConfig,
    frontendUrl: string,
    props: BackendStackProps
  ): void {
    const documentsLambda = new PythonFunction(this, "DocumentsLambda", {
      functionName: `${config.stack_name_base}-documents`,
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, "..", "lambdas", "documents"),
      handler: "handler",
      environment: {
        BUCKET_NAME: props.documentsBucketName!,
        KMS_KEY_ARN: props.documentsKeyArn || "",
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId!,
        DATA_SOURCE_ID: props.dataSourceId!,
        CORS_ALLOWED_ORIGINS: `${frontendUrl},http://localhost:3000`,
      },
      timeout: cdk.Duration.seconds(30),
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(
          this,
          "DocumentsPowertoolsLayer",
          `arn:aws:lambda:${
            cdk.Stack.of(this).region
          }:017000801446:layer:AWSLambdaPowertoolsPythonV3-python313-arm64:18`
        ),
      ],
      logGroup: new logs.LogGroup(this, "DocumentsLambdaLogGroup", {
        logGroupName: `/aws/lambda/${config.stack_name_base}-documents`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    // S3 permissions scoped to documents bucket
    const docsBucket = s3.Bucket.fromBucketArn(this, "ImportedDocsBucket", props.documentsBucketArn!)
    docsBucket.grantReadWrite(documentsLambda)
    docsBucket.grantDelete(documentsLambda)

    // KMS decrypt/encrypt permission for the documents key
    if (props.documentsKeyArn) {
      documentsLambda.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["kms:Decrypt", "kms:GenerateDataKey"],
          resources: [props.documentsKeyArn],
        })
      )
    }

    // Permission to trigger KB ingestion
    documentsLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:StartIngestionJob"],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/${props.knowledgeBaseId}`,
        ],
      })
    )

    // API Gateway for documents
    const docsApi = new apigateway.RestApi(this, "DocumentsApi", {
      restApiName: `${config.stack_name_base}-documents-api`,
      description: "Documents management API — upload, browse, delete",
      defaultCorsPreflightOptions: {
        allowOrigins: [frontendUrl, "http://localhost:3000"],
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
      },
      deployOptions: {
        stageName: "prod",
        throttlingRateLimit: 50,
        throttlingBurstLimit: 100,
        metricsEnabled: true,
      },
    })

    // Cognito authorizer
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "DocumentsApiAuthorizer",
      {
        cognitoUserPools: [this.userPool],
        identitySource: "method.request.header.Authorization",
        authorizerName: `${config.stack_name_base}-documents-authorizer`,
      }
    )

    const authMethodOptions = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    }

    const lambdaIntegration = new apigateway.LambdaIntegration(documentsLambda)

    // GET /documents — list
    const docsResource = docsApi.root.addResource("documents")
    docsResource.addMethod("GET", lambdaIntegration, authMethodOptions)

    // POST /documents/upload-url — presigned upload
    const uploadUrlResource = docsResource.addResource("upload-url")
    uploadUrlResource.addMethod("POST", lambdaIntegration, authMethodOptions)

    // POST /documents/download-url — presigned download
    const downloadUrlResource = docsResource.addResource("download-url")
    downloadUrlResource.addMethod("POST", lambdaIntegration, authMethodOptions)

    // DELETE /documents/{key} — delete
    const docByKeyResource = docsResource.addResource("{key}")
    docByKeyResource.addMethod("DELETE", lambdaIntegration, authMethodOptions)

    // POST /documents/sync — manual KB sync
    const syncResource = docsResource.addResource("sync")
    syncResource.addMethod("POST", lambdaIntegration, authMethodOptions)

    this.documentsApiUrl = docsApi.url

    new ssm.StringParameter(this, "DocumentsApiUrlParam", {
      parameterName: `/${config.stack_name_base}/documents-api-url`,
      stringValue: docsApi.url,
      description: "Documents API Gateway URL",
    })

    new cdk.CfnOutput(this, "DocumentsApiUrl", {
      value: docsApi.url,
      description: "Documents API Gateway URL",
    })
  }

  /**
   * Step 12c-v: Knowledge API — "What I Know" page CRUD for learned knowledge.
   */
  private createKnowledgeApi(config: AppConfig, frontendUrl: string): void {
    const knowledgeLambda = new PythonFunction(this, "KnowledgeLambda", {
      functionName: `${config.stack_name_base}-knowledge`,
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, "..", "lambdas", "knowledge"),
      handler: "handler",
      environment: {
        BUCKET_NAME: this.workspaceBucketName!,
        KMS_KEY_ARN: this.workspaceKeyArn || "",
        WORKSPACE_PREFIX: "",
        CORS_ALLOWED_ORIGINS: `${frontendUrl},http://localhost:3000`,
      },
      timeout: cdk.Duration.seconds(15),
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(
          this,
          "KnowledgePowertoolsLayer",
          `arn:aws:lambda:${
            cdk.Stack.of(this).region
          }:017000801446:layer:AWSLambdaPowertoolsPythonV3-python313-arm64:18`
        ),
      ],
      logGroup: new logs.LogGroup(this, "KnowledgeLambdaLogGroup", {
        logGroupName: `/aws/lambda/${config.stack_name_base}-knowledge`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    // S3: read learned/active/ entries + learned/config.json, write only to learned/active/
    knowledgeLambda.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "KnowledgeRead",
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetObject"],
        resources: [
          `arn:aws:s3:::${this.workspaceBucketName}/learned/active/*`,
          `arn:aws:s3:::${this.workspaceBucketName}/learned/config.json`,
        ],
      })
    )
    knowledgeLambda.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "KnowledgeWrite",
        effect: iam.Effect.ALLOW,
        actions: ["s3:PutObject"],
        resources: [`arn:aws:s3:::${this.workspaceBucketName}/learned/active/*`],
      })
    )
    knowledgeLambda.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "KnowledgeList",
        effect: iam.Effect.ALLOW,
        actions: ["s3:ListBucket", "s3:ListBucketVersions"],
        resources: [`arn:aws:s3:::${this.workspaceBucketName}`],
        conditions: {
          StringLike: { "s3:prefix": "learned/active/*" },
        },
      })
    )
    knowledgeLambda.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "KnowledgeVersions",
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetObjectVersion", "s3:ListObjectVersions"],
        resources: [`arn:aws:s3:::${this.workspaceBucketName}/learned/active/*`],
      })
    )

    if (this.workspaceKeyArn) {
      knowledgeLambda.addToRolePolicy(
        new iam.PolicyStatement({
          sid: "KnowledgeKMS",
          effect: iam.Effect.ALLOW,
          actions: ["kms:Decrypt", "kms:GenerateDataKey"],
          resources: [this.workspaceKeyArn],
        })
      )
    }

    // Add /knowledge routes to the shared API Gateway
    const knowledgeResource = this.restApi.root.addResource("knowledge")
    const lambdaIntegration = new apigateway.LambdaIntegration(knowledgeLambda)

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "KnowledgeApiAuthorizer",
      {
        cognitoUserPools: [this.userPool],
        identitySource: "method.request.header.Authorization",
        authorizerName: `${config.stack_name_base}-knowledge-authorizer`,
      }
    )
    const authMethodOptions = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    }

    // GET /knowledge — list categories
    knowledgeResource.addMethod("GET", lambdaIntegration, authMethodOptions)

    // GET /knowledge/{category} — list entries
    const categoryResource = knowledgeResource.addResource("{category}")
    categoryResource.addMethod("GET", lambdaIntegration, authMethodOptions)

    // POST /knowledge/{category} — add entry
    categoryResource.addMethod("POST", lambdaIntegration, authMethodOptions)

    // PUT /knowledge/{category}/{index} — update entry
    const entryResource = categoryResource.addResource("{index}")
    entryResource.addMethod("PUT", lambdaIntegration, authMethodOptions)

    // DELETE /knowledge/{category}/{index} — delete entry
    entryResource.addMethod("DELETE", lambdaIntegration, authMethodOptions)

    // POST /knowledge/{category}/undo — undo last change
    const undoResource = categoryResource.addResource("undo")
    undoResource.addMethod("POST", lambdaIntegration, authMethodOptions)
  }

  /**
   * Workspace Admin API — full workspace visibility and override management.
   */
  private createWorkspaceAdminApi(config: AppConfig, frontendUrl: string): void {
    const workspaceAdminLambda = new PythonFunction(this, "WorkspaceAdminLambda", {
      functionName: `${config.stack_name_base}-workspace-admin`,
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, "..", "lambdas", "workspace-admin"),
      handler: "handler",
      environment: {
        BUCKET_NAME: this.workspaceBucketName!,
        KMS_KEY_ARN: this.workspaceKeyArn || "",
        CORS_ALLOWED_ORIGINS: `${frontendUrl},http://localhost:3000`,
      },
      timeout: cdk.Duration.seconds(15),
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(
          this,
          "WorkspaceAdminPowertoolsLayer",
          `arn:aws:lambda:${
            cdk.Stack.of(this).region
          }:017000801446:layer:AWSLambdaPowertoolsPythonV3-python313-arm64:18`
        ),
      ],
      logGroup: new logs.LogGroup(this, "WorkspaceAdminLambdaLogGroup", {
        logGroupName: `/aws/lambda/${config.stack_name_base}-workspace-admin`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    // S3: full read/write/delete on workspace bucket (admin has full access)
    workspaceAdminLambda.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "WorkspaceAdminRead",
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetObject"],
        resources: [`arn:aws:s3:::${this.workspaceBucketName}/*`],
      })
    )
    workspaceAdminLambda.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "WorkspaceAdminWrite",
        effect: iam.Effect.ALLOW,
        actions: ["s3:PutObject", "s3:DeleteObject"],
        resources: [
          `arn:aws:s3:::${this.workspaceBucketName}/overrides/*`,
          `arn:aws:s3:::${this.workspaceBucketName}/learned/active/*`,
        ],
      })
    )
    workspaceAdminLambda.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "WorkspaceAdminList",
        effect: iam.Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [`arn:aws:s3:::${this.workspaceBucketName}`],
      })
    )

    if (this.workspaceKeyArn) {
      workspaceAdminLambda.addToRolePolicy(
        new iam.PolicyStatement({
          sid: "WorkspaceAdminKMS",
          effect: iam.Effect.ALLOW,
          actions: ["kms:Decrypt", "kms:GenerateDataKey"],
          resources: [this.workspaceKeyArn],
        })
      )
    }

    // Add /workspace routes to the shared API Gateway
    const workspaceResource = this.restApi.root.addResource("workspace")
    const wsLambdaIntegration = new apigateway.LambdaIntegration(workspaceAdminLambda)

    const wsAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "WorkspaceAdminApiAuthorizer",
      {
        cognitoUserPools: [this.userPool],
        identitySource: "method.request.header.Authorization",
        authorizerName: `${config.stack_name_base}-ws-admin-authorizer`,
      }
    )
    const wsAuthMethodOptions = {
      authorizer: wsAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    }

    // GET /workspace — list files
    workspaceResource.addMethod("GET", wsLambdaIntegration, wsAuthMethodOptions)

    // /workspace/file — GET (read), PUT (save override), DELETE (reset to core)
    const fileResource = workspaceResource.addResource("file")
    fileResource.addMethod("GET", wsLambdaIntegration, wsAuthMethodOptions)
    fileResource.addMethod("PUT", wsLambdaIntegration, wsAuthMethodOptions)
    fileResource.addMethod("DELETE", wsLambdaIntegration, wsAuthMethodOptions)

    // /workspace/learned — GET (list), PUT (edit), DELETE (delete)
    const learnedResource = workspaceResource.addResource("learned")
    learnedResource.addMethod("GET", wsLambdaIntegration, wsAuthMethodOptions)
    learnedResource.addMethod("PUT", wsLambdaIntegration, wsAuthMethodOptions)
    learnedResource.addMethod("DELETE", wsLambdaIntegration, wsAuthMethodOptions)
  }

  private createIntegrationsApi(config: AppConfig, frontendUrl: string): void {
    const stackNameLower = config.stack_name_base.toLowerCase()
    const oauthAppsSecretId = `/agentcore/${stackNameLower}/oauth-apps`

    const integrationsLambda = new PythonFunction(this, "IntegrationsAdminLambda", {
      functionName: `${config.stack_name_base}-integrations-admin`,
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, "..", "lambdas", "integrations-admin"),
      handler: "handler",
      environment: {
        STACK_NAME: stackNameLower,
        OAUTH_APPS_SECRET_ID: oauthAppsSecretId,
        FRONTEND_URL: frontendUrl,
        CORS_ALLOWED_ORIGINS: `${frontendUrl},http://localhost:3000`,
      },
      timeout: cdk.Duration.seconds(30),
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(
          this,
          "IntegrationsAdminPowertoolsLayer",
          `arn:aws:lambda:${
            cdk.Stack.of(this).region
          }:017000801446:layer:AWSLambdaPowertoolsPythonV3-python313-arm64:18`
        ),
      ],
      logGroup: new logs.LogGroup(this, "IntegrationsAdminLambdaLogGroup", {
        logGroupName: `/aws/lambda/${config.stack_name_base}-integrations-admin`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    // IAM: read oauth-apps secret
    integrationsLambda.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ReadOAuthApps",
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${oauthAppsSecretId}*`,
        ],
      })
    )

    // IAM: full CRUD on per-provider secrets (/agentcore/{stack}/*/oauth*)
    integrationsLambda.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ManageConnectorSecrets",
        effect: iam.Effect.ALLOW,
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:PutSecretValue",
          "secretsmanager:CreateSecret",
          "secretsmanager:DeleteSecret",
          "secretsmanager:DescribeSecret",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/agentcore/${stackNameLower}/*/oauth*`,
        ],
      })
    )

    // API Gateway routes
    const integrationsResource = this.restApi.root.addResource("integrations")
    const intLambdaIntegration = new apigateway.LambdaIntegration(integrationsLambda)

    const intAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "IntegrationsApiAuthorizer",
      {
        cognitoUserPools: [this.userPool],
        identitySource: "method.request.header.Authorization",
        authorizerName: `${config.stack_name_base}-integrations-authorizer`,
      }
    )
    const intAuthMethodOptions = {
      authorizer: intAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    }

    // GET /integrations — list all integration statuses (authenticated)
    integrationsResource.addMethod("GET", intLambdaIntegration, intAuthMethodOptions)

    // /integrations/{provider}
    const providerResource = integrationsResource.addResource("{provider}")

    // DELETE /integrations/{provider} — disconnect (authenticated)
    providerResource.addMethod("DELETE", intLambdaIntegration, intAuthMethodOptions)

    // /integrations/{provider}/auth-url — GET (authenticated)
    const authUrlResource = providerResource.addResource("auth-url")
    authUrlResource.addMethod("GET", intLambdaIntegration, intAuthMethodOptions)

    // /integrations/{provider}/callback — GET (NO auth — OAuth redirect from provider)
    const callbackResource = providerResource.addResource("callback")
    callbackResource.addMethod("GET", intLambdaIntegration)
  }

  private createAgentCoreGateway(config: AppConfig, knowledgeBaseId?: string): void {
    // Create sample tool Lambda
    const toolLambda = new lambda.Function(this, "SampleToolLambda", {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "sample_tool_lambda.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../../gateway/tools/sample_tool")),
      timeout: cdk.Duration.seconds(30),
      logGroup: new logs.LogGroup(this, "SampleToolLambdaLogGroup", {
        logGroupName: `/aws/lambda/${config.stack_name_base}-sample-tool`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    // Create comprehensive IAM role for gateway
    const gatewayRole = new iam.Role(this, "GatewayRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
      description: "Role for AgentCore Gateway with comprehensive permissions",
    })

    // Lambda invoke permission
    toolLambda.grantInvoke(gatewayRole)

    // Bedrock permissions (region-agnostic)
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [
          "arn:aws:bedrock:*::foundation-model/*",
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
        ],
      })
    )

    // SSM parameter access
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/${config.stack_name_base}/*`,
        ],
      })
    )

    // Cognito permissions
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cognito-idp:DescribeUserPoolClient", "cognito-idp:InitiateAuth"],
        resources: [this.userPool.userPoolArn],
      })
    )

    // CloudWatch Logs
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*`,
        ],
      })
    )

    // Policy Engine access (for Gateway to evaluate Cedar policies on tool calls)
    // Uses broad permissions because the service requires multiple undocumented actions
    // (GetPolicyEngine, Evaluate, CheckAuthorizePermissions, AuthorizeAction,
    //  PartiallyAuthorizeActions, and potentially others)
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["bedrock-agentcore:*"],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:policy-engine/*`,
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*`,
        ],
      })
    )

    // Load tool specification from JSON file
    const toolSpecPath = path.join(__dirname, "../../gateway/tools/sample_tool/tool_spec.json")
    const apiSpec = JSON.parse(require("fs").readFileSync(toolSpecPath, "utf8"))

    // Cognito OAuth2 configuration for gateway
    const cognitoIssuer = `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`
    const cognitoDiscoveryUrl = `${cognitoIssuer}/.well-known/openid-configuration`

    // Create OAuth2 Credential Provider for AgentCore Runtime to authenticate with AgentCore Gateway
    // Uses cr.Provider pattern with explicit Lambda to avoid logging secrets in CloudWatch
    const providerName = `${config.stack_name_base}-runtime-gateway-auth`

    // Lambda to create/delete OAuth2 provider
    const oauth2ProviderLambda = new lambda.Function(this, "OAuth2ProviderLambda", {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambdas", "oauth2-provider")),
      timeout: cdk.Duration.minutes(5),
      logGroup: new logs.LogGroup(this, "OAuth2ProviderLambdaLogGroup", {
        logGroupName: `/aws/lambda/${config.stack_name_base}-oauth2-provider`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    // Grant Lambda permissions to read machine client secret
    this.machineClientSecret.grantRead(oauth2ProviderLambda)

    // Grant Lambda permissions for Bedrock AgentCore operations
    // OAuth2 Credential Provider operations - scoped to all providers in default Token Vault
    // Note: Need both vault-level and nested resource permissions because:
    // - CreateOauth2CredentialProvider checks permission on vault itself (token-vault/default)
    // - Also checks permission on the nested resource path (token-vault/default/oauth2credentialprovider/*)
    oauth2ProviderLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock-agentcore:CreateOauth2CredentialProvider",
          "bedrock-agentcore:DeleteOauth2CredentialProvider",
          "bedrock-agentcore:GetOauth2CredentialProvider",
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:token-vault/default`,
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:token-vault/default/oauth2credentialprovider/*`,
        ],
      })
    )

    // Token Vault operations - scoped to default vault
    // Note: Need both exact match (default) and wildcard (default/*) because:
    // - AWS checks permission on the vault container itself (token-vault/default)
    // - AWS also checks permission on resources inside (token-vault/default/*)
    oauth2ProviderLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock-agentcore:CreateTokenVault",
          "bedrock-agentcore:GetTokenVault",
          "bedrock-agentcore:DeleteTokenVault",
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:token-vault/default`,
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:token-vault/default/*`,
        ],
      })
    )

    // Grant Lambda permissions for Token Vault secret management
    // Scoped to OAuth2 secrets in AgentCore Identity default namespace
    oauth2ProviderLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "secretsmanager:CreateSecret",
          "secretsmanager:DeleteSecret",
          "secretsmanager:DescribeSecret",
          "secretsmanager:PutSecretValue",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:bedrock-agentcore-identity!default/oauth2/*`,
        ],
      })
    )

    // Create Custom Resource Provider
    const oauth2Provider = new cr.Provider(this, "OAuth2ProviderProvider", {
      onEventHandler: oauth2ProviderLambda,
    })

    // Create Custom Resource
    const runtimeCredentialProvider = new cdk.CustomResource(this, "RuntimeCredentialProvider", {
      serviceToken: oauth2Provider.serviceToken,
      properties: {
        ProviderName: providerName,
        ClientSecretArn: this.machineClientSecret.secretArn,
        DiscoveryUrl: cognitoDiscoveryUrl,
        ClientId: this.machineClient.userPoolClientId,
      },
    })



    // Store for use in createAgentCoreRuntime()
    this.runtimeCredentialProvider = runtimeCredentialProvider

    // Create Gateway using L1 construct (CfnGateway)
    // This replaces the Custom Resource approach with native CloudFormation support
    const gateway = new bedrockagentcore.CfnGateway(this, "AgentCoreGateway", {
      name: `${config.stack_name_base}-gateway`,
      roleArn: gatewayRole.roleArn,
      protocolType: "MCP",
      protocolConfiguration: {
        mcp: {
          supportedVersions: ["2025-03-26"],
          // Optional: Enable semantic search for tools
          // searchType: "SEMANTIC",
        },
      },
      authorizerType: "CUSTOM_JWT",
      authorizerConfiguration: {
        customJwtAuthorizer: {
          allowedClients: [this.machineClient.userPoolClientId],
          discoveryUrl: cognitoDiscoveryUrl,
        },
      },
      description: "AgentCore Gateway with MCP protocol and JWT authentication",
    })

    // Create Gateway Target using L1 construct (CfnGatewayTarget)
    const gatewayTarget = new bedrockagentcore.CfnGatewayTarget(this, "GatewayTarget", {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: "sample-tool-target",
      description: "Sample tool Lambda target",
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: toolLambda.functionArn,
            toolSchema: {
              inlinePayload: apiSpec,
            },
          },
        },
      },
      credentialProviderConfigurations: [
        {
          credentialProviderType: "GATEWAY_IAM_ROLE",
        },
      ],
    })

    // Ensure proper creation order
    gatewayTarget.addDependency(gateway)
    gateway.node.addDependency(toolLambda)
    gateway.node.addDependency(this.machineClient)
    gateway.node.addDependency(gatewayRole)

    // ─── Knowledge Base search tool (Step 3b Gateway wiring) ─────────
    if (knowledgeBaseId) {
      const kbSearchLambda = new lambda.Function(this, "KbSearchLambda", {
        runtime: lambda.Runtime.PYTHON_3_13,
        handler: "kb_search_lambda.handler",
        code: lambda.Code.fromAsset(path.join(__dirname, "../../gateway/tools/kb_search")),
        timeout: cdk.Duration.seconds(30),
        environment: {
          KNOWLEDGE_BASE_ID: knowledgeBaseId,
        },
        logGroup: new logs.LogGroup(this, "KbSearchLambdaLogGroup", {
          logGroupName: `/aws/lambda/${config.stack_name_base}-kb-search`,
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      })

      // Grant KB search Lambda permission to call Bedrock KB Retrieve API
      kbSearchLambda.addToRolePolicy(
        new iam.PolicyStatement({
          sid: "BedrockKBRetrieve",
          effect: iam.Effect.ALLOW,
          actions: ["bedrock:Retrieve"],
          resources: [
            `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/${knowledgeBaseId}`,
          ],
        })
      )

      // Grant Gateway role permission to invoke KB search Lambda
      kbSearchLambda.grantInvoke(gatewayRole)

      // Load KB search tool spec
      const kbToolSpecPath = path.join(__dirname, "../../gateway/tools/kb_search/tool_spec.json")
      const kbToolSpec = JSON.parse(fs.readFileSync(kbToolSpecPath, "utf8"))

      // Register as Gateway Target
      const kbGatewayTarget = new bedrockagentcore.CfnGatewayTarget(this, "KbSearchTarget", {
        gatewayIdentifier: gateway.attrGatewayIdentifier,
        name: "kb-search-target",
        description: "Knowledge Base document search tool",
        targetConfiguration: {
          mcp: {
            lambda: {
              lambdaArn: kbSearchLambda.functionArn,
              toolSchema: {
                inlinePayload: kbToolSpec,
              },
            },
          },
        },
        credentialProviderConfigurations: [
          {
            credentialProviderType: "GATEWAY_IAM_ROLE",
          },
        ],
      })
      kbGatewayTarget.addDependency(gateway)

      new cdk.CfnOutput(this, "KbSearchTargetId", {
        value: kbGatewayTarget.ref,
        description: "KB Search Gateway Target ID",
      })
    }

    // ─── Microsoft 365 connector (Step 4b) ─────────────────────────────
    const m365SecretArn = `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/agentcore/${config.stack_name_base.toLowerCase()}/microsoft365/oauth*`

    const m365Lambda = new lambda.Function(this, "M365ConnectorLambda", {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "m365_connector_lambda.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../../gateway/tools/m365_connector")),
      timeout: cdk.Duration.seconds(30),
      environment: {
        M365_SECRET_ARN: `/agentcore/${config.stack_name_base.toLowerCase()}/microsoft365/oauth`,
      },
      logGroup: new logs.LogGroup(this, "M365LambdaLogGroup", {
        logGroupName: `/aws/lambda/${config.stack_name_base}-m365-connector`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    // Grant Lambda permission to read M365 OAuth secret
    m365Lambda.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ReadM365Secret",
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [m365SecretArn],
      })
    )

    // Grant Gateway role permission to invoke M365 Lambda
    m365Lambda.grantInvoke(gatewayRole)

    // Load M365 tool spec
    const m365ToolSpecPath = path.join(__dirname, "../../gateway/tools/m365_connector/tool_spec.json")
    const m365ToolSpec = JSON.parse(fs.readFileSync(m365ToolSpecPath, "utf8"))

    // Register as Gateway Target
    const m365GatewayTarget = new bedrockagentcore.CfnGatewayTarget(this, "M365ConnectorTarget", {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: "m365-connector-target",
      description: "Microsoft 365 connector — email, calendar, files via Graph API",
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: m365Lambda.functionArn,
            toolSchema: {
              inlinePayload: m365ToolSpec,
            },
          },
        },
      },
      credentialProviderConfigurations: [
        {
          credentialProviderType: "GATEWAY_IAM_ROLE",
        },
      ],
    })
    m365GatewayTarget.addDependency(gateway)

    new cdk.CfnOutput(this, "M365ConnectorTargetId", {
      value: m365GatewayTarget.ref,
      description: "M365 Connector Gateway Target ID",
    })

    // ─── Gmail connector (dev testing) ──────────────────────────────────
    const gmailSecretArn = `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/agentcore/${config.stack_name_base.toLowerCase()}/gmail/oauth*`

    const gmailLambda = new lambda.Function(this, "GmailConnectorLambda", {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "gmail_connector_lambda.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../../gateway/tools/gmail_connector")),
      timeout: cdk.Duration.seconds(30),
      environment: {
        GMAIL_SECRET_ARN: `/agentcore/${config.stack_name_base.toLowerCase()}/gmail/oauth`,
      },
      logGroup: new logs.LogGroup(this, "GmailLambdaLogGroup", {
        logGroupName: `/aws/lambda/${config.stack_name_base}-gmail-connector`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    gmailLambda.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ReadGmailSecret",
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [gmailSecretArn],
      })
    )

    gmailLambda.grantInvoke(gatewayRole)

    const gmailToolSpecPath = path.join(__dirname, "../../gateway/tools/gmail_connector/tool_spec.json")
    const gmailToolSpec = JSON.parse(fs.readFileSync(gmailToolSpecPath, "utf8"))

    const gmailGatewayTarget = new bedrockagentcore.CfnGatewayTarget(this, "GmailConnectorTarget", {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: "gmail-connector-target",
      description: "Gmail connector — list, read, send emails via Gmail API",
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: gmailLambda.functionArn,
            toolSchema: {
              inlinePayload: gmailToolSpec,
            },
          },
        },
      },
      credentialProviderConfigurations: [
        {
          credentialProviderType: "GATEWAY_IAM_ROLE",
        },
      ],
    })
    gmailGatewayTarget.addDependency(gateway)

    new cdk.CfnOutput(this, "GmailConnectorTargetId", {
      value: gmailGatewayTarget.ref,
      description: "Gmail Connector Gateway Target ID",
    })

    // ─── Xero Accounting connector (Step 14) ────────────────────────
    // Provides read-only financial data: P&L, bank balances, invoices, bills, contacts.
    // Xero rotates refresh tokens — Lambda needs GetSecretValue + PutSecretValue.
    const xeroSecretArn = `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/agentcore/${config.stack_name_base.toLowerCase()}/xero/oauth*`

    const xeroLambda = new lambda.Function(this, "XeroConnectorLambda", {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "xero_connector_lambda.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../../gateway/tools/xero_connector")),
      timeout: cdk.Duration.seconds(30),
      environment: {
        XERO_SECRET_ARN: `/agentcore/${config.stack_name_base.toLowerCase()}/xero/oauth`,
      },
      logGroup: new logs.LogGroup(this, "XeroLambdaLogGroup", {
        logGroupName: `/aws/lambda/${config.stack_name_base}-xero-connector`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    xeroLambda.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ReadWriteXeroSecret",
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"],
        resources: [xeroSecretArn],
      })
    )

    xeroLambda.grantInvoke(gatewayRole)

    const xeroToolSpecPath = path.join(__dirname, "../../gateway/tools/xero_connector/tool_spec.json")
    const xeroToolSpec = JSON.parse(fs.readFileSync(xeroToolSpecPath, "utf8"))

    const xeroGatewayTarget = new bedrockagentcore.CfnGatewayTarget(this, "XeroConnectorTarget", {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: "xero-connector-target",
      description: "Xero Accounting — financial reports, invoices, bills, contacts (read-only)",
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: xeroLambda.functionArn,
            toolSchema: {
              inlinePayload: xeroToolSpec,
            },
          },
        },
      },
      credentialProviderConfigurations: [
        {
          credentialProviderType: "GATEWAY_IAM_ROLE",
        },
      ],
    })
    xeroGatewayTarget.addDependency(gateway)

    new cdk.CfnOutput(this, "XeroConnectorTargetId", {
      value: xeroGatewayTarget.ref,
      description: "Xero Connector Gateway Target ID",
    })

    // ─── Slack connector (Step 14) ──────────────────────────────────
    // Read channels/messages, search, send messages/DMs. Bot tokens don't expire.
    const slackSecretArn = `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/agentcore/${config.stack_name_base.toLowerCase()}/slack/oauth*`

    const slackLambda = new lambda.Function(this, "SlackConnectorLambda", {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "slack_connector_lambda.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../../gateway/tools/slack_connector")),
      timeout: cdk.Duration.seconds(30),
      environment: {
        SLACK_SECRET_ARN: `/agentcore/${config.stack_name_base.toLowerCase()}/slack/oauth`,
      },
      logGroup: new logs.LogGroup(this, "SlackLambdaLogGroup", {
        logGroupName: `/aws/lambda/${config.stack_name_base}-slack-connector`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    slackLambda.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ReadSlackSecret",
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [slackSecretArn],
      })
    )

    slackLambda.grantInvoke(gatewayRole)

    const slackToolSpecPath = path.join(__dirname, "../../gateway/tools/slack_connector/tool_spec.json")
    const slackToolSpec = JSON.parse(fs.readFileSync(slackToolSpecPath, "utf8"))

    const slackGatewayTarget = new bedrockagentcore.CfnGatewayTarget(this, "SlackConnectorTarget", {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: "slack-connector-target",
      description: "Slack — read channels, search messages, send messages and DMs",
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: slackLambda.functionArn,
            toolSchema: {
              inlinePayload: slackToolSpec,
            },
          },
        },
      },
      credentialProviderConfigurations: [
        {
          credentialProviderType: "GATEWAY_IAM_ROLE",
        },
      ],
    })
    slackGatewayTarget.addDependency(gateway)

    new cdk.CfnOutput(this, "SlackConnectorTargetId", {
      value: slackGatewayTarget.ref,
      description: "Slack Connector Gateway Target ID",
    })

    // ─── Workspace Manager tool (Step 12c) ──────────────────────────
    // Provides read/write/list access to the agent's modular workspace in S3.
    // Writes restricted to learned/active/ only via IAM + Lambda code.
    if (this.workspaceBucketName) {
      const workspaceLambda = new lambda.Function(this, "WorkspaceManagerLambda", {
        runtime: lambda.Runtime.PYTHON_3_13,
        handler: "workspace_manager_lambda.handler",
        code: lambda.Code.fromAsset(path.join(__dirname, "../../gateway/tools/workspace_manager")),
        timeout: cdk.Duration.seconds(15),
        environment: {
          WORKSPACE_BUCKET: this.workspaceBucketName!,
          WORKSPACE_PREFIX: "",
        },
        logGroup: new logs.LogGroup(this, "WorkspaceManagerLogGroup", {
          logGroupName: `/aws/lambda/${config.stack_name_base}-workspace-manager`,
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      })

      // Read access to all workspace files
      workspaceLambda.addToRolePolicy(
        new iam.PolicyStatement({
          sid: "WorkspaceRead",
          effect: iam.Effect.ALLOW,
          actions: ["s3:GetObject"],
          resources: [`arn:aws:s3:::${this.workspaceBucketName}/*`],
        })
      )

      // Write access restricted to learned/active/ only
      workspaceLambda.addToRolePolicy(
        new iam.PolicyStatement({
          sid: "WorkspaceWriteLearned",
          effect: iam.Effect.ALLOW,
          actions: ["s3:PutObject"],
          resources: [`arn:aws:s3:::${this.workspaceBucketName}/learned/active/*`],
        })
      )

      // List access for all workspace files (needed for override checks and listing rooms/skills)
      workspaceLambda.addToRolePolicy(
        new iam.PolicyStatement({
          sid: "WorkspaceList",
          effect: iam.Effect.ALLOW,
          actions: ["s3:ListBucket"],
          resources: [`arn:aws:s3:::${this.workspaceBucketName}`],
        })
      )

      // KMS decrypt/encrypt for the workspace bucket key
      if (this.workspaceKeyArn) {
        workspaceLambda.addToRolePolicy(
          new iam.PolicyStatement({
            sid: "WorkspaceKMS",
            effect: iam.Effect.ALLOW,
            actions: ["kms:Decrypt", "kms:GenerateDataKey"],
            resources: [this.workspaceKeyArn],
          })
        )
      }

      // Grant Gateway role permission to invoke workspace Lambda
      workspaceLambda.grantInvoke(gatewayRole)

      // Load workspace tool spec
      const wsToolSpecPath = path.join(__dirname, "../../gateway/tools/workspace_manager/tool_spec.json")
      const wsToolSpec = JSON.parse(fs.readFileSync(wsToolSpecPath, "utf8"))

      // Register as Gateway Target
      const wsGatewayTarget = new bedrockagentcore.CfnGatewayTarget(this, "WorkspaceManagerTarget", {
        gatewayIdentifier: gateway.attrGatewayIdentifier,
        name: "workspace-manager-target",
        description: "Workspace file read/write/list tool for agent context loading",
        targetConfiguration: {
          mcp: {
            lambda: {
              lambdaArn: workspaceLambda.functionArn,
              toolSchema: {
                inlinePayload: wsToolSpec,
              },
            },
          },
        },
        credentialProviderConfigurations: [
          {
            credentialProviderType: "GATEWAY_IAM_ROLE",
          },
        ],
      })
      wsGatewayTarget.addDependency(gateway)

      new cdk.CfnOutput(this, "WorkspaceManagerTargetId", {
        value: wsGatewayTarget.ref,
        description: "Workspace Manager Gateway Target ID",
      })
    }

    // Store AgentCore Gateway URL in SSM for AgentCore Runtime access
    new ssm.StringParameter(this, "GatewayUrlParam", {
      parameterName: `/${config.stack_name_base}/gateway_url`,
      stringValue: gateway.attrGatewayUrl,
      description: "AgentCore Gateway URL",
    })

    // Output gateway information
    new cdk.CfnOutput(this, "GatewayId", {
      value: gateway.attrGatewayIdentifier,
      description: "AgentCore Gateway ID",
    })

    new cdk.CfnOutput(this, "GatewayUrl", {
      value: gateway.attrGatewayUrl,
      description: "AgentCore Gateway URL",
    })

    new cdk.CfnOutput(this, "GatewayArn", {
      value: gateway.attrGatewayArn,
      description: "AgentCore Gateway ARN",
    })

    new cdk.CfnOutput(this, "GatewayTargetId", {
      value: gatewayTarget.ref,
      description: "AgentCore Gateway Target ID",
    })

    new cdk.CfnOutput(this, "ToolLambdaArn", {
      description: "ARN of the sample tool Lambda",
      value: toolLambda.functionArn,
    })
  }

  private createMachineAuthentication(config: AppConfig): void {
    // Create Resource Server for Machine-to-Machine (M2M) authentication
    // This defines the API scopes that machine clients can request access to
    const resourceServer = new cognito.UserPoolResourceServer(this, "ResourceServer", {
      userPool: this.userPool,
      identifier: `${config.stack_name_base}-gateway`,
      userPoolResourceServerName: `${config.stack_name_base}-gateway-resource-server`,
      scopes: [
        new cognito.ResourceServerScope({
          scopeName: "read",
          scopeDescription: "Read access to gateway",
        }),
        new cognito.ResourceServerScope({
          scopeName: "write",
          scopeDescription: "Write access to gateway",
        }),
      ],
    })

    // Create Machine Client for AgentCore Gateway authentication
    //
    // WHAT IS A MACHINE CLIENT?
    // A machine client is a Cognito User Pool Client configured for server-to-server authentication
    // using the OAuth2 Client Credentials flow. Unlike user-facing clients, it doesn't require
    // human interaction or user credentials.
    //
    // HOW IS IT DIFFERENT FROM THE REGULAR USER POOL CLIENT?
    // - Regular client: Uses Authorization Code flow for human users (frontend login)
    // - Machine client: Uses Client Credentials flow for service-to-service authentication
    // - Regular client: No client secret (public client for frontend security)
    // - Machine client: Has client secret (confidential client for backend security)
    // - Regular client: Scopes are openid, email, profile (user identity)
    // - Machine client: Scopes are custom resource server scopes (API permissions)
    //
    // WHY IS IT NEEDED?
    // The AgentCore Gateway needs to authenticate with Cognito to validate tokens and make
    // API calls on behalf of the system. The machine client provides the credentials for
    // this service-to-service authentication without requiring user interaction.
    this.machineClient = new cognito.UserPoolClient(this, "MachineClient", {
      userPool: this.userPool,
      userPoolClientName: `${config.stack_name_base}-machine-client`,
      generateSecret: true, // Required for client credentials flow
      oAuth: {
        flows: {
          clientCredentials: true, // Enable OAuth2 Client Credentials flow
        },
        scopes: [
          // Grant access to the resource server scopes defined above
          cognito.OAuthScope.resourceServer(
            resourceServer,
            new cognito.ResourceServerScope({
              scopeName: "read",
              scopeDescription: "Read access to gateway",
            })
          ),
          cognito.OAuthScope.resourceServer(
            resourceServer,
            new cognito.ResourceServerScope({
              scopeName: "write",
              scopeDescription: "Write access to gateway",
            })
          ),
        ],
      },
    })

    // Machine client must be created after resource server
    this.machineClient.node.addDependency(resourceServer)

    // Store machine client secret in Secrets Manager for testing and external access.
    // This secret is used by test scripts and potentially other external tools.
    this.machineClientSecret = new secretsmanager.Secret(this, "MachineClientSecret", {
      secretName: `/${config.stack_name_base}/machine_client_secret`,
      secretStringValue: cdk.SecretValue.unsafePlainText(
        this.machineClient.userPoolClientSecret.unsafeUnwrap()
      ),
      description: "Machine Client Secret for M2M authentication",
    })


  }

  /**
   * Builds the RuntimeNetworkConfiguration based on the config.yaml settings.
   * When network_mode is "VPC", imports the user's existing VPC, subnets, and
   * optionally security groups, then returns a VPC-based network configuration.
   * When network_mode is "PUBLIC" (default), returns a public network configuration.
   *
   * @param config - The application configuration from config.yaml.
   * @returns A RuntimeNetworkConfiguration for the AgentCore Runtime.
   */
  private buildNetworkConfiguration(config: AppConfig): agentcore.RuntimeNetworkConfiguration {
    if (config.backend.network_mode === "VPC") {
      const vpcConfig = config.backend.vpc
      // vpc config is validated in ConfigManager, but guard here for type safety
      if (!vpcConfig) {
        throw new Error("backend.vpc configuration is required when network_mode is 'VPC'.")
      }

      // Import the user's existing VPC by ID.
      // This performs a context lookup at synth time to resolve VPC attributes.
      const vpc = ec2.Vpc.fromLookup(this, "ImportedVpc", {
        vpcId: vpcConfig.vpc_id,
      })

      // Import the user-specified subnets by their IDs.
      // These subnets must exist within the VPC specified above.
      const subnets: ec2.ISubnet[] = vpcConfig.subnet_ids.map(
        (subnetId: string, index: number) =>
          ec2.Subnet.fromSubnetId(this, `ImportedSubnet${index}`, subnetId)
      )

      // Build the VPC config props for the AgentCore L2 construct.
      // Security groups are optional — if not provided, the construct creates a default one.
      const securityGroups =
        vpcConfig.security_group_ids && vpcConfig.security_group_ids.length > 0
          ? vpcConfig.security_group_ids.map(
              (sgId: string, index: number) =>
                ec2.SecurityGroup.fromSecurityGroupId(this, `ImportedSG${index}`, sgId)
            )
          : undefined

      const vpcConfigProps: agentcore.VpcConfigProps = {
        vpc: vpc,
        vpcSubnets: {
          subnets: subnets,
        },
        securityGroups: securityGroups,
      }

      return agentcore.RuntimeNetworkConfiguration.usingVpc(this, vpcConfigProps)
    }

    // Default: public network mode
    return agentcore.RuntimeNetworkConfiguration.usingPublicNetwork()
  }

  /**
   * Recursively read directory contents and encode as base64.
   *
   * @param dirPath - Directory to read.
   * @param prefix - Prefix for file paths in output.
   * @param output - Output object to populate.
   */
  private readDirRecursive(dirPath: string, prefix: string, output: Record<string, string>): void {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name)
      const relativePath = path.join(prefix, entry.name)

      if (entry.isDirectory()) {
        // Skip __pycache__ directories
        if (entry.name !== "__pycache__") {
          this.readDirRecursive(fullPath, relativePath, output)
        }
      } else if (entry.isFile()) {
        const content = fs.readFileSync(fullPath)
        output[relativePath] = content.toString("base64")
      }
    }
  }

  /**
   * Create a hash of content for change detection.
   *
   * @param content - Content to hash.
   * @returns Hash string.
   */
  private hashContent(content: string): string {
    const crypto = require("crypto")
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16)
  }

  /**
   * Step 16a: Transcribe API — presigned WebSocket URL for streaming + batch transcription.
   *
   * API Contract - GET /transcribe/presigned-url
   * Authorization: Bearer <cognito-access-token> (required)
   * Query params:
   *   language_code: string (optional, default "en-AU")
   *   sample_rate: number (optional, default 16000)
   *
   * Success Response (200):
   *   { url: string, expires_in: number }
   *
   * Direct Lambda invocation (for WhatsApp webhook):
   *   Input:  { action: "transcribe_file", s3_uri: "s3://bucket/key", language_code?: string }
   *   Output: { transcript: string } | { error: string }
   *
   * Implementation: infra-cdk/lambdas/transcribe/index.py
   */
  private createTranscribeApi(config: AppConfig, frontendUrl: string): void {
    const transcribeLambda = new PythonFunction(this, "TranscribeLambda", {
      functionName: `${config.stack_name_base}-transcribe`,
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, "..", "lambdas", "transcribe"),
      handler: "handler",
      environment: {
        DEFAULT_LANGUAGE: "en-AU",
        CORS_ALLOWED_ORIGINS: `${frontendUrl},http://localhost:3000`,
        OPS_BUCKET: `${config.stack_name_base.toLowerCase()}-ops-${cdk.Stack.of(this).account}`,
        // Set after Lambda creation below
      },
      timeout: cdk.Duration.seconds(120),
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(
          this,
          "TranscribePowertoolsLayer",
          `arn:aws:lambda:${
            cdk.Stack.of(this).region
          }:017000801446:layer:AWSLambdaPowertoolsPythonV3-python313-arm64:18`
        ),
      ],
      logGroup: new logs.LogGroup(this, "TranscribeLambdaLogGroup", {
        logGroupName: `/aws/lambda/${config.stack_name_base}-transcribe`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    // Pass Lambda's own role ARN so Transcribe can use it for S3/KMS access
    transcribeLambda.addEnvironment("DATA_ACCESS_ROLE_ARN", transcribeLambda.role!.roleArn)

    // Allow Transcribe service to assume the Lambda's role
    ;(transcribeLambda.role as iam.Role).assumeRolePolicy!.addStatements(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        principals: [new iam.ServicePrincipal("transcribe.amazonaws.com")],
      })
    )

    // IAM: PassRole so Lambda can pass its own role to Transcribe via DataAccessRoleArn
    transcribeLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [transcribeLambda.role!.roleArn],
        conditions: {
          StringEquals: { "iam:PassedToService": "transcribe.amazonaws.com" },
        },
      })
    )

    // IAM: Transcribe streaming (presigned URL credentials) + batch transcription
    transcribeLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "transcribe:StartStreamTranscription",
          "transcribe:StartTranscriptionJob",
          "transcribe:GetTranscriptionJob",
          "transcribe:DeleteTranscriptionJob",
        ],
        resources: ["*"],
      })
    )

    // IAM: S3 access for audio files (upload from browser, read for Transcribe, cleanup)
    const opsBucketName = `${config.stack_name_base.toLowerCase()}-ops-${cdk.Stack.of(this).account}`
    transcribeLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        resources: [`arn:aws:s3:::${opsBucketName}/voice-input/*`],
      })
    )
    // KMS: ops bucket uses KMS encryption
    transcribeLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["kms:GenerateDataKey", "kms:Decrypt"],
        resources: [`arn:aws:kms:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:key/*`],
      })
    )
    // Transcribe needs GetObject on any bucket (it reads from its own output bucket too)
    transcribeLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: ["arn:aws:s3:::*"],
      })
    )

    // Add /transcribe/presigned-url resource to the existing REST API
    const transcribeAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "TranscribeApiAuthorizer",
      {
        cognitoUserPools: [this.userPool],
        identitySource: "method.request.header.Authorization",
        authorizerName: `${config.stack_name_base}-transcribe-authorizer`,
      }
    )

    const transcribeResource = this.restApi.root.addResource("transcribe")
    const presignedUrlResource = transcribeResource.addResource("presigned-url")
    presignedUrlResource.addMethod(
      "GET",
      new apigateway.LambdaIntegration(transcribeLambda),
      {
        authorizer: transcribeAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      }
    )

    // POST /transcribe/audio — receive base64 audio, transcribe, return text
    const audioResource = transcribeResource.addResource("audio")
    audioResource.addMethod(
      "POST",
      new apigateway.LambdaIntegration(transcribeLambda),
      {
        authorizer: transcribeAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      }
    )

    // Export Lambda ARN for WhatsApp webhook to invoke directly
    new cdk.CfnOutput(this, "TranscribeLambdaArn", {
      value: transcribeLambda.functionArn,
      description: "Transcribe Lambda ARN for direct invocation",
    })
  }

  /**
   * Step 16d+16e: WhatsApp Webhook — incoming messages, voice notes, user mappings.
   *
   * Creates:
   * - WhatsApp user-mappings DynamoDB table (partition key: phoneNumber in E.164)
   * - WhatsApp webhook Lambda (handles GET verification + POST messages)
   * - API Gateway endpoints (no Cognito auth — Meta sends webhooks directly)
   *
   * Webhook endpoints:
   *   GET  /whatsapp — Meta verification challenge (hub.verify_token)
   *   POST /whatsapp — Incoming messages (text + voice notes)
   *
   * Implementation: infra-cdk/lambdas/whatsapp-webhook/index.py
   */
  private createWhatsAppWebhook(
    config: AppConfig,
    frontendUrl: string,
    auditTable: dynamodb.Table
  ): void {
    const clientChannels = config.client!.channels!.whatsapp!

    // Step 16e: WhatsApp user-mappings DynamoDB table
    const userMappingsTable = new dynamodb.Table(this, "WhatsAppUserMappingsTable", {
      tableName: `${config.stack_name_base}-whatsapp-mappings`,
      partitionKey: { name: "phoneNumber", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    // Step 16f: Pending approvals table for WhatsApp approval flow
    const pendingApprovalsTable = new dynamodb.Table(this, "WhatsAppPendingApprovalsTable", {
      tableName: `${config.stack_name_base}-pending-approvals`,
      partitionKey: { name: "phoneNumber", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    // Import existing secrets — use lowercase clientId for secret name
    // (secrets are created with lowercase clientId via CLI/deploy scripts)
    const clientIdLower = config.stack_name_base.toLowerCase()
    const whatsappSecret = secretsmanager.Secret.fromSecretNameV2(
      this, "WhatsAppSecret",
      `/agentcore/${clientIdLower}/whatsapp/access-token`
    )

    // Ops bucket for temporary voice note storage
    const opsBucketName = `${config.stack_name_base.toLowerCase()}-ops-${cdk.Stack.of(this).account}`

    // Cognito domain for token endpoint
    const cognitoDomain = `https://${this.userPoolDomain.domainName}.auth.${cdk.Aws.REGION}.amazoncognito.com`

    const webhookLambda = new PythonFunction(this, "WhatsAppWebhookLambda", {
      functionName: `${config.stack_name_base}-wa-webhook`,
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, "..", "lambdas", "whatsapp-webhook"),
      handler: "handler",
      environment: {
        PHONE_NUMBER_ID: clientChannels.phoneNumberId || "",
        WHATSAPP_SECRET_ARN: whatsappSecret.secretArn,
        VERIFY_TOKEN: "agentcore-webhook-verify",
        RUNTIME_ARN: this.runtimeArn,
        COGNITO_DOMAIN: cognitoDomain,
        MACHINE_CLIENT_ID: this.machineClient.userPoolClientId,
        MACHINE_CLIENT_SECRET_ARN: this.machineClientSecret.secretArn,
        RESOURCE_SERVER_ID: `${config.stack_name_base}-gateway`,
        USER_MAPPINGS_TABLE: userMappingsTable.tableName,
        AUDIT_TABLE: auditTable.tableName,
        PENDING_APPROVALS_TABLE: pendingApprovalsTable.tableName,
        OPS_BUCKET: opsBucketName,
        ...(config.client?.channels?.voiceToText?.enabled ? {
          TRANSCRIBE_LAMBDA_ARN: `arn:aws:lambda:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:function:${config.stack_name_base}-transcribe`,
        } : {}),
      },
      timeout: cdk.Duration.seconds(300),
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(
          this,
          "WhatsAppPowertoolsLayer",
          `arn:aws:lambda:${
            cdk.Stack.of(this).region
          }:017000801446:layer:AWSLambdaPowertoolsPythonV3-python313-arm64:18`
        ),
      ],
      logGroup: new logs.LogGroup(this, "WhatsAppWebhookLogGroup", {
        logGroupName: `/aws/lambda/${config.stack_name_base}-wa-webhook`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    // IAM permissions
    userMappingsTable.grantReadData(webhookLambda)
    pendingApprovalsTable.grantReadWriteData(webhookLambda)
    auditTable.grantWriteData(webhookLambda)
    whatsappSecret.grantRead(webhookLambda)
    this.machineClientSecret.grantRead(webhookLambda)

    // S3: read/write voice notes to ops bucket
    webhookLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:DeleteObject"],
        resources: [`arn:aws:s3:::${opsBucketName}/whatsapp-voice/*`],
      })
    )

    // Invoke Transcribe Lambda for voice notes
    webhookLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [`arn:aws:lambda:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:function:${config.stack_name_base}-transcribe`],
      })
    )

    // Add /whatsapp resource to the existing REST API — NO Cognito auth (Meta sends webhooks directly)
    const whatsappResource = this.restApi.root.addResource("whatsapp")

    // GET: Webhook verification (Meta sends hub.verify_token challenge)
    whatsappResource.addMethod(
      "GET",
      new apigateway.LambdaIntegration(webhookLambda)
    )

    // POST: Incoming messages
    whatsappResource.addMethod(
      "POST",
      new apigateway.LambdaIntegration(webhookLambda)
    )

    // Output the webhook URL for Meta configuration
    new cdk.CfnOutput(this, "WhatsAppWebhookUrl", {
      value: `${this.restApi.url}whatsapp`,
      description: "WhatsApp webhook URL — register this in Meta Developer Console",
    })

    new cdk.CfnOutput(this, "WhatsAppVerifyToken", {
      value: "agentcore-webhook-verify",
      description: "WhatsApp webhook verify token",
    })

    // Step 16g: CloudWatch alarms for WhatsApp webhook
    new cloudwatch.Alarm(this, "WhatsAppWebhookErrorAlarm", {
      alarmName: `${config.stack_name_base}-wa-webhook-errors`,
      alarmDescription: "WhatsApp webhook error rate > 5%",
      metric: webhookLambda.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 5,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })

    new cloudwatch.Alarm(this, "WhatsAppWebhookLatencyAlarm", {
      alarmName: `${config.stack_name_base}-wa-webhook-latency`,
      alarmDescription: "WhatsApp webhook latency p99 > 10 seconds",
      metric: webhookLambda.metricDuration({
        period: cdk.Duration.minutes(5),
        statistic: "p99",
      }),
      threshold: 10000,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })
  }
}