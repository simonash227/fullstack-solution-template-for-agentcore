import json
import logging
import os
import re
from datetime import datetime, timezone

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3 = boto3.client("s3", region_name=os.environ.get("AWS_DEFAULT_REGION", "ap-southeast-2"))

BUCKET_NAME = os.environ.get("WORKSPACE_BUCKET", "")
PREFIX = os.environ.get("WORKSPACE_PREFIX", "agent-workspace/")
LEARNED_PREFIX = f"{PREFIX}learned/active/"
MAX_ENTRY_LENGTH = 500

# Reject content that looks like prompt injection
INJECTION_PATTERNS = [
    r"(?i)ignore\s+(previous|above|all)\s+instructions",
    r"(?i)you\s+are\s+now\s+",
    r"(?i)system\s*:\s*",
    r"(?i)<\s*/?system",
]


def _sanitise_content(content: str) -> str:
    """Strip markdown headers, code blocks, and prompt injection patterns."""
    if not content or len(content) > MAX_ENTRY_LENGTH:
        raise ValueError(f"Content must be 1-{MAX_ENTRY_LENGTH} characters")

    for pattern in INJECTION_PATTERNS:
        if re.search(pattern, content):
            raise ValueError("Content contains disallowed patterns")

    # Strip markdown headers and code blocks
    content = re.sub(r"^#{1,6}\s+", "", content, flags=re.MULTILINE)
    content = re.sub(r"```[\s\S]*?```", "", content)
    return content.strip()


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
    """Read a workspace file from S3."""
    key = _validate_read_path(path)
    logger.info(f"Reading workspace file: s3://{BUCKET_NAME}/{key}")

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


def _write_entry(category: str, content: str, entry_type: str, source: str = "web_chat") -> dict:
    """Append an entry to a learned knowledge file."""
    if not category:
        raise ValueError("category is required for write action")
    if not content:
        raise ValueError("content is required for write action")

    content = _sanitise_content(content)
    entry_type = entry_type or "fact"
    now = datetime.now(timezone.utc)

    # Calculate review date
    months = 6 if entry_type == "policy" else 3
    review_month = now.month + months
    review_year = now.year + (review_month - 1) // 12
    review_month = ((review_month - 1) % 12) + 1
    review_date = now.replace(year=review_year, month=review_month).strftime("%Y-%m-%d")

    entry = (
        f"\n<!-- ENTRY -->\n"
        f"- content: {content}\n"
        f"- noted: {now.strftime('%Y-%m-%d')}\n"
        f"- source: {source}\n"
        f"- type: {entry_type}\n"
        f"- review: {review_date}\n"
        f"<!-- /ENTRY -->\n"
    )

    key = f"{LEARNED_PREFIX}{category}.md"
    logger.info(f"Writing entry to s3://{BUCKET_NAME}/{key}")

    # Read-modify-write with ETag for concurrency safety
    existing = ""
    etag = None
    try:
        response = s3.get_object(Bucket=BUCKET_NAME, Key=key)
        existing = response["Body"].read().decode("utf-8")
        etag = response["ETag"]
    except s3.exceptions.NoSuchKey:
        pass  # New file

    new_content = existing + entry

    put_kwargs = {"Bucket": BUCKET_NAME, "Key": key, "Body": new_content.encode("utf-8"), "ContentType": "text/markdown"}
    if etag:
        # Conditional write — fails if file was modified since we read it
        try:
            s3.put_object(**put_kwargs, IfMatch=etag)
        except s3.exceptions.ClientError as e:
            if e.response["Error"]["Code"] == "PreconditionFailed":
                raise ValueError("File was modified by another process. Please retry.")
            raise
    else:
        s3.put_object(**put_kwargs)

    return {
        "content": [{"type": "text", "text": f"Saved to {category}: {content[:80]}..."}],
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

    Provides read/write/list access to the agent's modular workspace in S3.
    Writes are restricted to learned/active/ only (IAM + code enforcement).
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
            return _write_entry(
                category=event.get("category", ""),
                content=event.get("content", ""),
                entry_type=event.get("entry_type", "fact"),
                source=event.get("source", "web_chat"),
            )
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
