"""Workspace Admin API Lambda — full workspace visibility and override management."""

import os
import re

import boto3
from aws_lambda_powertools import Logger
from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig
from aws_lambda_powertools.logging.correlation_paths import API_GATEWAY_REST
from aws_lambda_powertools.utilities.typing import LambdaContext

BUCKET_NAME = os.environ["BUCKET_NAME"]
KMS_KEY_ARN = os.environ.get("KMS_KEY_ARN", "")
CORS_ALLOWED_ORIGINS = os.environ.get("CORS_ALLOWED_ORIGINS", "*")

cors_origins = [
    origin.strip() for origin in CORS_ALLOWED_ORIGINS.split(",") if origin.strip()
]
primary_origin = cors_origins[0] if cors_origins else "*"
extra_origins = cors_origins[1:] if len(cors_origins) > 1 else None

cors_config = CORSConfig(
    allow_origin=primary_origin,
    extra_origins=extra_origins,
    allow_headers=["Content-Type", "Authorization"],
    allow_credentials=True,
)

s3 = boto3.client("s3")
logger = Logger()
app = APIGatewayRestResolver(cors=cors_config)

# Valid workspace file categories (excludes learned/ — separate routes)
VALID_CATEGORIES = {"domains/", "client/"}
VALID_ROOT_FILES = {"map.md", "base-persona.md"}
PROTECTED_FILES = {"map.md", "base-persona.md"}  # Can override but not delete
LEARNED_PREFIX = "learned/active/"
MAX_FILE_SIZE_BYTES = 50_000  # 50KB

INJECTION_PATTERNS = [
    r"(?i)ignore\s+(previous|above|all)\s+instructions",
    r"(?i)you\s+are\s+now\s+",
    r"(?i)system\s*:\s*",
    r"(?i)<\s*/?system",
]


def _validate_path(path: str) -> str:
    """Validate a workspace file path. Returns the normalised path."""
    if not path:
        raise ValueError("path is required")

    # Prevent path traversal
    normalised = os.path.normpath(path).replace("\\", "/")
    if normalised.startswith("..") or "/../" in normalised or normalised.startswith("/"):
        raise ValueError("Invalid path")

    # Must be in a known category or be a known root file
    if normalised in VALID_ROOT_FILES:
        return normalised
    for prefix in VALID_CATEGORIES:
        if normalised.startswith(prefix):
            return normalised

    raise ValueError(f"Path not in allowed categories: {normalised}")


def _list_s3_files(prefix: str = "") -> list[dict]:
    """List all files under a prefix in the workspace bucket."""
    files = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET_NAME, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            # Skip directories (keys ending with /)
            if key.endswith("/"):
                continue
            files.append({
                "key": key,
                "size": obj["Size"],
                "lastModified": obj["LastModified"].isoformat(),
            })
    return files


def _read_s3_file(key: str) -> str | None:
    """Read a file from S3. Returns None if not found."""
    try:
        response = s3.get_object(Bucket=BUCKET_NAME, Key=key)
        return response["Body"].read().decode("utf-8")
    except s3.exceptions.NoSuchKey:
        return None
    except Exception:
        return None


def _parse_entries(content: str) -> list[dict]:
    """Parse <!-- ENTRY --> blocks from learned knowledge markdown."""
    entries = []
    blocks = content.split("<!-- ENTRY -->")
    for block in blocks[1:]:
        end = block.find("<!-- /ENTRY -->")
        if end == -1:
            continue
        entry_text = block[:end].strip()
        entry = {}
        for line in entry_text.splitlines():
            line = line.strip()
            if line.startswith("- ") and ": " in line:
                key, value = line[2:].split(": ", 1)
                entry[key.strip()] = value.strip()
        entries.append(entry)
    return entries


def _entries_to_markdown(entries: list[dict]) -> str:
    """Convert entry dicts back to markdown format."""
    parts = []
    for entry in entries:
        part = (
            f"\n<!-- ENTRY -->\n"
            f"- content: {entry.get('content', '')}\n"
            f"- noted: {entry.get('noted', '')}\n"
            f"- source: {entry.get('source', 'web_ui')}\n"
            f"- type: {entry.get('type', 'fact')}\n"
            f"- review: {entry.get('review', '')}\n"
            f"<!-- /ENTRY -->\n"
        )
        parts.append(part)
    return "".join(parts)


@app.get("/workspace")
def list_workspace_files():
    """List all workspace files with override status. Excludes learned/active/."""
    # Get core files (root-level)
    core_files = _list_s3_files("")
    # Get override files
    override_files = _list_s3_files("overrides/")

    # Build override lookup
    override_keys = set()
    for f in override_files:
        # overrides/rooms/foo.md -> rooms/foo.md
        original_path = f["key"].removeprefix("overrides/")
        override_keys.add(original_path)

    # Build merged file list
    files = []
    seen_paths = set()

    for f in core_files:
        key = f["key"]
        # Skip overrides/ prefix files (they'll be merged), learned/, and insights/
        if key.startswith("overrides/") or key.startswith("learned/") or key.startswith("insights/"):
            continue

        # Determine category
        if key in VALID_ROOT_FILES:
            category = "root"
        elif key.startswith("domains/"):
            category = "domains"
        elif key.startswith("client/"):
            category = "client"
        else:
            continue  # Skip unknown files

        is_overridden = key in override_keys
        files.append({
            "path": key,
            "category": category,
            "isOverridden": is_overridden,
            "size": f["size"],
            "lastModified": f["lastModified"],
        })
        seen_paths.add(key)

    # Add overrides for files that don't exist in core (new override-only files)
    for f in override_files:
        original_path = f["key"].removeprefix("overrides/")
        if original_path not in seen_paths:
            if original_path in VALID_ROOT_FILES:
                category = "root"
            elif original_path.startswith("domains/"):
                category = "domains"
            elif original_path.startswith("client/"):
                category = "client"
            else:
                continue

            files.append({
                "path": original_path,
                "category": category,
                "isOverridden": True,
                "isOverrideOnly": True,
                "size": f["size"],
                "lastModified": f["lastModified"],
            })

    return {"files": sorted(files, key=lambda x: x["path"])}


@app.get("/workspace/learned")
def list_learned():
    """List learned categories and entries for admin view."""
    results = []
    learned_files = _list_s3_files(LEARNED_PREFIX)

    for f in learned_files:
        cat = f["key"].removeprefix(LEARNED_PREFIX).removesuffix(".md")
        content = _read_s3_file(f["key"])
        if content is not None:
            entries = _parse_entries(content)
            for i, e in enumerate(entries):
                e["index"] = i
            results.append({
                "category": cat,
                "count": len(entries),
                "entries": entries,
            })

    return {"categories": sorted(results, key=lambda x: x["category"])}


@app.get("/workspace/file")
def read_workspace_file():
    """Read a workspace file. Returns both core and override versions if applicable."""
    path = app.current_event.get_query_string_value("path")
    validated_path = _validate_path(path)

    core_content = _read_s3_file(validated_path)
    override_content = _read_s3_file(f"overrides/{validated_path}")

    if core_content is None and override_content is None:
        return {"error": f"File not found: {path}"}, 404

    active = "override" if override_content is not None else "core"

    return {
        "path": validated_path,
        "core": core_content,
        "override": override_content,
        "active": active,
    }


@app.put("/workspace/file")
def save_workspace_file():
    """Write to overrides/{path}. Rejects writes to learned/active/."""
    body = app.current_event.json_body or {}
    path = body.get("path", "")
    content = body.get("content", "")

    validated_path = _validate_path(path)

    if not content:
        return {"error": "content is required"}, 400

    content_bytes = content.encode("utf-8")
    if len(content_bytes) > MAX_FILE_SIZE_BYTES:
        return {"error": f"Content exceeds {MAX_FILE_SIZE_BYTES // 1000}KB limit"}, 400

    override_key = f"overrides/{validated_path}"
    logger.info(f"Writing override: s3://{BUCKET_NAME}/{override_key}")

    s3.put_object(
        Bucket=BUCKET_NAME,
        Key=override_key,
        Body=content_bytes,
        ContentType="text/markdown",
    )

    return {"message": "Override saved", "path": validated_path}


@app.delete("/workspace/file")
def reset_workspace_file():
    """Delete overrides/{path} to reset to core version. Cannot delete core files."""
    path = app.current_event.get_query_string_value("path")
    validated_path = _validate_path(path)

    override_key = f"overrides/{validated_path}"

    # Check the override exists
    override_content = _read_s3_file(override_key)
    if override_content is None:
        return {"error": "No override exists for this file"}, 404

    # Protected files must have a core version to fall back to
    if validated_path in PROTECTED_FILES:
        core_content = _read_s3_file(validated_path)
        if core_content is None:
            return {"error": f"{validated_path} is protected and has no core version to fall back to"}, 400

    logger.info(f"Deleting override: s3://{BUCKET_NAME}/{override_key}")
    s3.delete_object(Bucket=BUCKET_NAME, Key=override_key)

    return {"message": "Reset to core version", "path": validated_path}


@app.put("/workspace/learned")
def edit_learned_entry():
    """Edit a learned entry by category and index."""
    body = app.current_event.json_body or {}
    category = body.get("category", "")
    index = body.get("index")
    new_content = body.get("content", "")

    if not category or index is None or not new_content:
        return {"error": "category, index, and content are required"}, 400

    # Sanitise content
    if len(new_content) > 500:
        return {"error": "Content must be 500 characters or less"}, 400
    for pattern in INJECTION_PATTERNS:
        if re.search(pattern, new_content):
            return {"error": "Content contains disallowed patterns"}, 400

    key = f"{LEARNED_PREFIX}{category}.md"
    content = _read_s3_file(key)
    if content is None:
        return {"error": "Category not found"}, 404

    entries = _parse_entries(content)
    idx = int(index)
    if idx < 0 or idx >= len(entries):
        return {"error": "Entry not found"}, 404

    entries[idx]["content"] = new_content
    s3.put_object(
        Bucket=BUCKET_NAME,
        Key=key,
        Body=_entries_to_markdown(entries).encode("utf-8"),
        ContentType="text/markdown",
    )
    return {"message": "Entry updated"}


@app.delete("/workspace/learned")
def delete_learned_entry():
    """Delete a learned entry by category and index."""
    category = app.current_event.get_query_string_value("category")
    index = app.current_event.get_query_string_value("index")

    if not category or index is None:
        return {"error": "category and index query params are required"}, 400

    key = f"{LEARNED_PREFIX}{category}.md"
    content = _read_s3_file(key)
    if content is None:
        return {"error": "Category not found"}, 404

    entries = _parse_entries(content)
    idx = int(index)
    if idx < 0 or idx >= len(entries):
        return {"error": "Entry not found"}, 404

    entries.pop(idx)
    s3.put_object(
        Bucket=BUCKET_NAME,
        Key=key,
        Body=_entries_to_markdown(entries).encode("utf-8"),
        ContentType="text/markdown",
    )
    return {"message": "Entry deleted"}


@logger.inject_lambda_context(correlation_id_path=API_GATEWAY_REST)
def handler(event, context: LambdaContext):
    return app.resolve(event, context)
