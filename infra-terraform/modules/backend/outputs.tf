# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# =============================================================================
# Memory Outputs
# =============================================================================

output "memory_id" {
  description = "AgentCore Memory ID"
  value       = aws_bedrockagentcore_memory.main.id
}

output "memory_arn" {
  description = "AgentCore Memory ARN"
  value       = aws_bedrockagentcore_memory.main.arn
}

# =============================================================================
# Gateway Outputs
# =============================================================================

output "gateway_id" {
  description = "AgentCore Gateway ID"
  value       = aws_bedrockagentcore_gateway.main.gateway_id
}

output "gateway_arn" {
  description = "AgentCore Gateway ARN"
  value       = aws_bedrockagentcore_gateway.main.gateway_arn
}

output "gateway_url" {
  description = "AgentCore Gateway URL"
  value       = aws_bedrockagentcore_gateway.main.gateway_url
}

output "gateway_target_id" {
  description = "AgentCore Gateway Target ID"
  value       = aws_bedrockagentcore_gateway_target.sample_tool.target_id
}

output "tool_lambda_arn" {
  description = "Sample tool Lambda function ARN"
  value       = aws_lambda_function.sample_tool.arn
}

# =============================================================================
# Runtime Outputs
# =============================================================================

output "runtime_id" {
  description = "AgentCore Runtime ID"
  value       = aws_bedrockagentcore_agent_runtime.main.agent_runtime_id
}

output "runtime_arn" {
  description = "AgentCore Runtime ARN"
  value       = aws_bedrockagentcore_agent_runtime.main.agent_runtime_arn
}

output "runtime_role_arn" {
  description = "AgentCore Runtime execution role ARN"
  value       = aws_iam_role.runtime.arn
}

output "ecr_repository_url" {
  description = "ECR repository URL for agent container (docker mode only)"
  value       = local.is_docker && var.container_uri == null ? aws_ecr_repository.agent[0].repository_url : null
}

output "agent_code_bucket" {
  description = "S3 bucket for agent code packages (zip mode only)"
  value       = local.is_zip ? aws_s3_bucket.agent_code[0].id : null
}

output "agent_code_key" {
  description = "S3 object key for agent deployment package (zip mode only)"
  value       = local.is_zip ? "deployment_package.zip" : null
}

output "deployment_type" {
  description = "Deployment type used (docker or zip)"
  value       = var.deployment_type
}

# =============================================================================
# Feedback API Outputs
# =============================================================================

output "feedback_api_url" {
  description = "Feedback API endpoint URL"
  value       = "${aws_api_gateway_stage.prod.invoke_url}/feedback"
}

output "feedback_api_id" {
  description = "Feedback API Gateway REST API ID"
  value       = aws_api_gateway_rest_api.feedback.id
}

output "feedback_table_name" {
  description = "Feedback DynamoDB table name"
  value       = aws_dynamodb_table.feedback.name
}

output "feedback_lambda_arn" {
  description = "Feedback Lambda function ARN"
  value       = aws_lambda_function.feedback.arn
}

# =============================================================================
# Machine Client Outputs
# =============================================================================

output "machine_client_id" {
  description = "Cognito Machine Client ID (for M2M authentication)"
  value       = aws_cognito_user_pool_client.machine.id
}
