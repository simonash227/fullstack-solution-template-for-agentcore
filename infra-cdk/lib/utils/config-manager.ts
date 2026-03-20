import * as fs from "fs"
import * as path from "path"
import * as yaml from "yaml"

const MAX_STACK_NAME_BASE_LENGTH = 35

export type DeploymentType = "docker" | "zip"

/**
 * Network mode for the AgentCore Runtime.
 * - PUBLIC: Runtime is accessible over the public internet (default).
 * - VPC: Runtime is deployed into a user-provided VPC for private network isolation.
 */
export type NetworkMode = "PUBLIC" | "VPC"

/**
 * VPC configuration for deploying the AgentCore Runtime into an existing VPC.
 * Required when network_mode is "VPC".
 */
export interface VpcConfig {
  /** The ID of the existing VPC to deploy into (e.g. "vpc-0abc1234def56789a"). */
  vpc_id: string
  /** List of subnet IDs within the VPC where the runtime will be placed. */
  subnet_ids: string[]
  /** Optional list of security group IDs. If omitted, a default security group is created. */
  security_group_ids?: string[]
}

/**
 * Client-specific configuration loaded from client-config.json.
 * Controls branding, integrations, channels, and workspace settings per client.
 */
export interface ClientConfig {
  clientId: string
  clientName: string
  region: string
  adminEmail: string
  integrations: string[]
  branding: {
    primaryColour: string
    logoUrl?: string
    firmName: string
    agentName: string
  }
  quickActions: string[]
  auth?: {
    accessTokenValidityHours?: number
    refreshTokenValidityDays?: number
  }
  knowledge?: {
    categories?: Array<{ id: string; label: string; description: string }>
  }
  workspace?: {
    overrides?: string[]
  }
  channels?: {
    voiceToText?: { enabled: boolean }
    whatsapp?: {
      enabled: boolean
      phoneNumberId?: string
      businessAccountId?: string
    }
  }
}

export interface AppConfig {
  stack_name_base: string
  admin_user_email?: string | null
  /** ARN of the CloudWatch OAM sink in the monitoring account. If set, creates a cross-account OAM link. */
  monitoring_sink_arn?: string | null
  backend: {
    pattern: string
    deployment_type: DeploymentType
    /** Network mode for the AgentCore Runtime. Defaults to "PUBLIC". */
    network_mode: NetworkMode
    /** VPC configuration. Required when network_mode is "VPC". */
    vpc?: VpcConfig
  }
  /** Client-specific configuration. Loaded from client-config.json when provided. */
  client?: ClientConfig
}

export class ConfigManager {
  private config: AppConfig

  constructor(configFile: string, clientConfigFile?: string) {
    this.config = this._loadConfig(configFile, clientConfigFile)
  }

  private _loadConfig(configFile: string, clientConfigFile?: string): AppConfig {
    const configPath = path.join(__dirname, "..", "..", configFile)

    if (!fs.existsSync(configPath)) {
      throw new Error(`Configuration file ${configPath} does not exist. Please create config.yaml file.`)
    }

    try {
      const fileContent = fs.readFileSync(configPath, "utf8")
      const parsedConfig = yaml.parse(fileContent) as AppConfig

      const deploymentType = parsedConfig.backend?.deployment_type || "docker"
      if (deploymentType !== "docker" && deploymentType !== "zip") {
        throw new Error(`Invalid deployment_type '${deploymentType}'. Must be 'docker' or 'zip'.`)
      }

      const stackNameBase = parsedConfig.stack_name_base
      if (!stackNameBase) {
        throw new Error("stack_name_base is required in config.yaml")
      }
      if (stackNameBase.length > MAX_STACK_NAME_BASE_LENGTH) {
        throw new Error(
          `stack_name_base '${stackNameBase}' is too long (${stackNameBase.length} chars). ` +
            `Maximum length is ${MAX_STACK_NAME_BASE_LENGTH} characters due to AWS AgentCore runtime naming constraints.`
        )
      }

      // Validate network_mode if provided
      const networkMode = parsedConfig.backend?.network_mode || "PUBLIC"
      if (networkMode !== "PUBLIC" && networkMode !== "VPC") {
        throw new Error(`Invalid network_mode '${networkMode}'. Must be 'PUBLIC' or 'VPC'.`)
      }

      // Validate VPC configuration when network_mode is VPC
      const vpcConfig = parsedConfig.backend?.vpc
      if (networkMode === "VPC") {
        if (!vpcConfig) {
          throw new Error("backend.vpc configuration is required when network_mode is 'VPC'.")
        }
        if (!vpcConfig.vpc_id) {
          throw new Error("backend.vpc.vpc_id is required when network_mode is 'VPC'.")
        }
        if (!vpcConfig.subnet_ids || vpcConfig.subnet_ids.length === 0) {
          throw new Error("backend.vpc.subnet_ids must contain at least one subnet ID when network_mode is 'VPC'.")
        }
      }

      // Load client config: from separate file (production) or inline in config.yaml (dev)
      let clientConfig: ClientConfig | undefined
      if (clientConfigFile) {
        clientConfig = this._loadClientConfig(clientConfigFile)
      } else if (parsedConfig.client) {
        clientConfig = parsedConfig.client as ClientConfig
      }

      return {
        stack_name_base: clientConfig?.clientId || stackNameBase,
        admin_user_email: clientConfig?.adminEmail || parsedConfig.admin_user_email || null,
        monitoring_sink_arn: parsedConfig.monitoring_sink_arn || null,
        backend: {
          pattern: parsedConfig.backend?.pattern || "strands-single-agent",
          deployment_type: deploymentType,
          network_mode: networkMode,
          vpc: vpcConfig,
        },
        client: clientConfig,
      }
    } catch (error) {
      throw new Error(`Failed to parse configuration file ${configPath}: ${error}`)
    }
  }

  private _loadClientConfig(clientConfigFile: string): ClientConfig {
    // Resolve relative to infra-cdk directory or absolute path
    const configPath = path.isAbsolute(clientConfigFile)
      ? clientConfigFile
      : path.join(__dirname, "..", "..", clientConfigFile)

    if (!fs.existsSync(configPath)) {
      throw new Error(`Client config file ${configPath} does not exist.`)
    }

    const fileContent = fs.readFileSync(configPath, "utf8")
    const config = JSON.parse(fileContent) as ClientConfig

    // Validate required fields
    if (!config.clientId) {
      throw new Error("clientId is required in client-config.json")
    }
    if (config.clientId.length > 20) {
      throw new Error(
        `clientId '${config.clientId}' is too long (${config.clientId.length} chars). Maximum is 20 characters.`
      )
    }
    if (!/^[a-z0-9-]+$/.test(config.clientId)) {
      throw new Error(
        `clientId '${config.clientId}' contains invalid characters. Use lowercase letters, numbers, and hyphens only.`
      )
    }
    if (!config.clientName) {
      throw new Error("clientName is required in client-config.json")
    }
    if (!config.branding?.firmName || !config.branding?.agentName) {
      throw new Error("branding.firmName and branding.agentName are required in client-config.json")
    }

    return config
  }

  public getProps(): AppConfig {
    return this.config
  }

  public get(key: string, defaultValue?: any): any {
    const keys = key.split(".")
    let value: any = this.config

    for (const k of keys) {
      if (typeof value === "object" && value !== null && k in value) {
        value = value[k]
      } else {
        return defaultValue
      }
    }

    return value
  }
}
