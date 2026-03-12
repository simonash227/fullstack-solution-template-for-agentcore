"""
Audit logging utility for DynamoDB (Step 5b).

Writes an audit record after every tool call for compliance.
Professional services firms need a full audit trail of what the agent did,
when, and for whom. Records are retained for 7 years (TTL set at write time).
"""

import json
import logging
import os
import time
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

_dynamodb_table = None
_cloudwatch_client = None
_SEVEN_YEARS_SECONDS = 7 * 365 * 24 * 60 * 60


def _get_audit_table():
    """Lazy-init DynamoDB table resource."""
    global _dynamodb_table
    if _dynamodb_table is None:
        table_name = os.environ.get("AUDIT_TABLE_NAME")
        if not table_name:
            logger.warning("[AUDIT] AUDIT_TABLE_NAME not set — audit logging disabled")
            return None
        region = os.environ.get(
            "AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "ap-southeast-2")
        )
        dynamodb = boto3.resource("dynamodb", region_name=region)
        _dynamodb_table = dynamodb.Table(table_name)
    return _dynamodb_table


def log_tool_call(
    session_id: str,
    user_id: str,
    tool_name: str,
    tool_input: dict | None = None,
    tool_output: str | None = None,
    result: str = "success",
    workflow_id: str | None = None,
) -> None:
    """
    Write an audit record to DynamoDB after a tool call.

    Args:
        session_id: The conversation session ID.
        user_id: The authenticated user's ID (from JWT sub claim).
        tool_name: Name of the tool that was called.
        tool_input: Tool input parameters (truncated for storage).
        tool_output: Tool output summary (truncated for storage).
        result: "success" or "error".
        workflow_id: Optional workflow/trace ID for grouping related calls.
    """
    table = _get_audit_table()
    if table is None:
        return

    now = datetime.now(timezone.utc)
    timestamp = now.isoformat()

    # Truncate input/output to avoid large DynamoDB items (400KB limit)
    input_summary = _truncate(json.dumps(tool_input, default=str)) if tool_input else ""
    output_summary = _truncate(tool_output or "")

    item = {
        "sessionId": session_id,
        "timestamp": timestamp,
        "userId": user_id,
        "action": tool_name,
        "system": "strands-agent",
        "result": result,
        "inputSummary": input_summary,
        "outputSummary": output_summary,
        "datePrefix": now.strftime("%Y-%m-%d"),
        "expiresAt": int(time.time()) + _SEVEN_YEARS_SECONDS,
    }

    if workflow_id:
        item["workflowId"] = workflow_id

    try:
        table.put_item(Item=item)
    except ClientError as e:
        logger.error(f"[AUDIT] Failed to write audit record: {e}")
        _emit_audit_failure_metric()


def _emit_audit_failure_metric():
    """Emit a CloudWatch metric when an audit write fails."""
    global _cloudwatch_client
    try:
        if _cloudwatch_client is None:
            region = os.environ.get(
                "AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "ap-southeast-2")
            )
            _cloudwatch_client = boto3.client("cloudwatch", region_name=region)
        stack_name = os.environ.get("STACK_NAME", "unknown")
        _cloudwatch_client.put_metric_data(
            Namespace="AgentCore/Operations",
            MetricData=[
                {
                    "MetricName": "AuditWriteFailure",
                    "Value": 1,
                    "Unit": "Count",
                    "Dimensions": [
                        {"Name": "StackName", "Value": stack_name},
                    ],
                }
            ],
        )
    except Exception as metric_err:
        logger.error(f"[AUDIT] Failed to emit failure metric: {metric_err}")


def _truncate(text: str, max_length: int = 2000) -> str:
    """Truncate text to max_length, appending '...[truncated]' if needed."""
    if len(text) <= max_length:
        return text
    return text[: max_length - 14] + "...[truncated]"
