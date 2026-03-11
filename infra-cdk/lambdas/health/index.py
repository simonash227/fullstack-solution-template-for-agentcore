"""Client health endpoint Lambda (Step 5e).

Returns the health status of the agent runtime and knowledge base.
Secured with API key — not public.

Environment variables:
    RUNTIME_ARN: AgentCore Runtime ARN
    KNOWLEDGE_BASE_ID: Bedrock Knowledge Base ID
    STACK_NAME: Stack name for context
"""

import json
import os
import time
from datetime import datetime, timezone

import boto3


def handler(event, context):
    runtime_arn = os.environ.get("RUNTIME_ARN", "")
    kb_id = os.environ.get("KNOWLEDGE_BASE_ID", "")
    stack_name = os.environ.get("STACK_NAME", "unknown")

    result = {
        "status": "ok",
        "stack": stack_name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "agent": {"status": "unknown"},
        "knowledgeBase": {"status": "unknown"},
    }

    # Check 1: AgentCore Runtime
    # Use the control plane API to check runtime status (data plane requires OAuth,
    # which a Lambda can't easily obtain without a Cognito user credential).
    try:
        agentcore_control = boto3.client("bedrock-agentcore-control")
        # Extract runtime ID from ARN: arn:aws:bedrock-agentcore:region:account:runtime/ID
        runtime_id = runtime_arn.rsplit("/", 1)[-1] if "/" in runtime_arn else runtime_arn
        response = agentcore_control.get_agent_runtime(agentRuntimeId=runtime_id)
        runtime_status = response.get("status", "UNKNOWN")

        result["agent"] = {
            "status": "ok" if runtime_status in ("ACTIVE", "READY") else "degraded",
            "runtimeStatus": runtime_status,
        }
    except Exception as e:
        result["agent"] = {
            "status": "down",
            "error": str(e),
        }
        result["status"] = "degraded"

    # Check 2: Knowledge Base
    try:
        bedrock_agent = boto3.client("bedrock-agent")
        kb_response = bedrock_agent.get_knowledge_base(knowledgeBaseId=kb_id)
        kb_status = kb_response["knowledgeBase"]["status"]

        # List data sources to get last sync info
        ds_response = bedrock_agent.list_data_sources(knowledgeBaseId=kb_id)
        last_ingestion = None
        for ds in ds_response.get("dataSourceSummaries", []):
            ds_detail = bedrock_agent.get_data_source(
                knowledgeBaseId=kb_id,
                dataSourceId=ds["dataSourceId"],
            )
            updated = ds_detail["dataSource"].get("updatedAt")
            if updated:
                if last_ingestion is None or updated > last_ingestion:
                    last_ingestion = updated

        result["knowledgeBase"] = {
            "status": "ok" if kb_status == "ACTIVE" else "degraded",
            "kbStatus": kb_status,
            "lastIngestion": last_ingestion.isoformat() if last_ingestion else None,
        }

        if kb_status != "ACTIVE":
            result["status"] = "degraded"

    except Exception as e:
        result["knowledgeBase"] = {
            "status": "down",
            "error": str(e),
        }
        if result["status"] == "ok":
            result["status"] = "degraded"

    # If both are down, overall is down
    if result["agent"]["status"] == "down" and result["knowledgeBase"]["status"] == "down":
        result["status"] = "down"

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(result, indent=2, default=str),
    }
