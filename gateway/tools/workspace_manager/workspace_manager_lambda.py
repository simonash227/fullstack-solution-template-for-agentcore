import json
import logging
import os

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3 = boto3.client("s3", region_name=os.environ.get("AWS_DEFAULT_REGION", "ap-southeast-2"))

BUCKET_NAME = os.environ.get("WORKSPACE_BUCKET", "")
PREFIX = os.environ.get("WORKSPACE_PREFIX", "")
LEARNED_PREFIX = f"{PREFIX}learned/active/"


def _validate_read_path(path: str) -> str:
    """Validate and normalise the read path. Returns full S3 key."""
    if not path:
        raise ValueError("path is required for read action")

    # Prevent path traversal
    normalised = os.path.normpath(path).replace("\\", "/")
    if normalised.startswith("..") or "/../" in normalised or normalised.startswith("/"):
        raise ValueError("Invalid path")

    return f"{PREFIX}{normalised}"


def _read_file(path: str) -> dict:
    """Read a workspace file from S3. Checks overrides/ first, falls back to core."""
    key = _validate_read_path(path)
    override_key = f"{PREFIX}overrides/{os.path.normpath(path).replace(chr(92), '/')}"
    logger.info(f"Reading workspace file: checking override s3://{BUCKET_NAME}/{override_key} then s3://{BUCKET_NAME}/{key}")

    # Check override first
    try:
        response = s3.get_object(Bucket=BUCKET_NAME, Key=override_key)
        content = response["Body"].read().decode("utf-8")
        logger.info(f"Using override version for {path}")
        return {
            "content": [{"type": "text", "text": content}],
        }
    except s3.exceptions.NoSuchKey:
        pass  # No override, fall through to core

    # Fall back to core
    try:
        response = s3.get_object(Bucket=BUCKET_NAME, Key=key)
        content = response["Body"].read().decode("utf-8")
        return {
            "content": [{"type": "text", "text": content}],
        }
    except s3.exceptions.NoSuchKey:
        return {
            "content": [{"type": "text", "text": f"File not found: {path}"}],
        }


def _list_entries(category: str = None) -> dict:
    """List learned knowledge entries."""
    if category:
        key = f"{LEARNED_PREFIX}{category}.md"
        try:
            response = s3.get_object(Bucket=BUCKET_NAME, Key=key)
            content = response["Body"].read().decode("utf-8")
            entries = content.count("<!-- ENTRY -->")
            return {
                "content": [{"type": "text", "text": f"## {category} ({entries} entries)\n\n{content}"}],
            }
        except s3.exceptions.NoSuchKey:
            return {
                "content": [{"type": "text", "text": f"No entries found for {category}"}],
            }
    else:
        # List all categories with entry counts
        result_lines = ["## Learned Knowledge\n"]
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=BUCKET_NAME, Prefix=LEARNED_PREFIX):
            for obj in page.get("Contents", []):
                cat_name = obj["Key"].replace(LEARNED_PREFIX, "").replace(".md", "")
                try:
                    resp = s3.get_object(Bucket=BUCKET_NAME, Key=obj["Key"])
                    text = resp["Body"].read().decode("utf-8")
                    count = text.count("<!-- ENTRY -->")
                    result_lines.append(f"- **{cat_name}**: {count} entries")
                except Exception:
                    result_lines.append(f"- **{cat_name}**: (error reading)")

        if len(result_lines) == 1:
            result_lines.append("No learned knowledge yet.")

        return {
            "content": [{"type": "text", "text": "\n".join(result_lines)}],
        }


def handler(event, context):
    """
    Workspace manager tool Lambda for AgentCore Gateway.

    Provides read-only access to workspace files and learned knowledge in S3.
    Writing to learned knowledge is managed by the team via the What I Know page.
    """
    logger.info(f"Received event: {json.dumps(event)}")

    try:
        # Get tool name from context and strip target prefix
        delimiter = "___"
        original_tool_name = context.client_context.custom["bedrockAgentCoreToolName"]
        tool_name = original_tool_name[original_tool_name.index(delimiter) + len(delimiter):]
        logger.info(f"Processing tool: {tool_name}")

        if tool_name != "workspace_manager":
            return {"error": f"This Lambda only supports 'workspace_manager', received: {tool_name}"}

        action = event.get("action")
        if not action:
            return {"error": "action is required"}

        if action == "read":
            return _read_file(event.get("path", ""))
        elif action == "write":
            return {
                "content": [{"type": "text", "text": "Writing knowledge is managed by the team via the What I Know page in the app. You can read knowledge with the list action, but cannot write to it directly."}],
            }
        elif action == "list":
            return _list_entries(event.get("category"))
        else:
            return {"error": f"Unknown action: {action}. Use read, write, or list."}

    except ValueError as e:
        logger.warning(f"Validation error: {e}")
        return {"error": str(e)}
    except Exception as e:
        logger.error(f"Error processing request: {e}")
        return {"error": f"Internal server error: {str(e)}"}
