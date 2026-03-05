# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# =============================================================================
# Core Configuration
# =============================================================================

variable "stack_name_base" {
  description = "Base name for all resources."
  type        = string
}

variable "backend_pattern" {
  description = "Agent pattern to deploy."
  type        = string
  default     = "strands-single-agent"
}

variable "deployment_type" {
  description = "Deployment type: 'docker' (container via ECR) or 'zip' (Python package via S3)."
  type        = string
  default     = "docker"
}

variable "agent_name" {
  description = "Name for the agent runtime."
  type        = string
  default     = "StrandsAgent"
}

variable "network_mode" {
  description = "Network mode for AgentCore resources (PUBLIC or PRIVATE)."
  type        = string
  default     = "PUBLIC"
}

variable "memory_event_expiry_days" {
  description = "Number of days after which memory events expire."
  type        = number
  default     = 30
}

variable "environment" {
  description = "Environment name for tagging."
  type        = string
  default     = "dev"
}

# =============================================================================
# VPC Configuration (Required if network_mode = PRIVATE)
# =============================================================================

variable "vpc_id" {
  description = "VPC ID for private network mode."
  type        = string
  default     = null
}

variable "private_subnet_ids" {
  description = "List of private subnet IDs for private network mode."
  type        = list(string)
  default     = []
}

variable "security_group_ids" {
  description = "List of security group IDs for private network mode."
  type        = list(string)
  default     = []
}

# =============================================================================
# Cognito Configuration (passed from cognito module)
# =============================================================================

variable "user_pool_id" {
  description = "Cognito User Pool ID."
  type        = string
}

variable "user_pool_arn" {
  description = "Cognito User Pool ARN."
  type        = string
}

variable "web_client_id" {
  description = "Cognito Web Client ID (for frontend OAuth)."
  type        = string
}

# =============================================================================
# Amplify Configuration (passed from amplify module)
# =============================================================================

variable "frontend_url" {
  description = "Frontend URL for CORS and callback configuration."
  type        = string
}

variable "cognito_domain_url" {
  description = "Cognito domain URL for OAuth token endpoint."
  type        = string
}

# =============================================================================
# Optional Configuration
# =============================================================================

variable "container_uri" {
  description = "Container image URI. If not provided, ECR repository will be created."
  type        = string
  default     = null
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days."
  type        = number
  default     = 7
}

variable "throttling_rate_limit" {
  description = "API Gateway throttling rate limit."
  type        = number
  default     = 100
}

variable "throttling_burst_limit" {
  description = "API Gateway throttling burst limit."
  type        = number
  default     = 200
}

variable "tags" {
  description = "Tags to apply to all resources."
  type        = map(string)
  default     = {}
}
