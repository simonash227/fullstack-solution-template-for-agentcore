"""Knowledge API Lambda Handler — CRUD for learned knowledge entries (What I Know page)."""

import os
import re
from datetime import datetime, timezone

import boto3
from aws_lambda_powertools import Logger
from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig
from aws_lambda_powertools.logging.correlation_paths import API_GATEWAY_REST
from aws_lambda_powertools.utilities.typing import LambdaContext

BUCKET_NAME = os.environ["BUCKET_NAME"]
KMS_KEY_ARN = os.environ.get("KMS_KEY_ARN", "")
CORS_ALLOWED_ORIGINS = os.environ.get("CORS_ALLOWED_ORIGINS", "*")
WORKSPACE_PREFIX = os.environ.get("WORKSPACE_PREFIX", "agent-workspace/")
LEARNED_PREFIX = f"{WORKSPACE_PREFIX}learned/active/"

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

VALID_CATEGORIES = {"policies", "people-updates", "key-dates", "preferences"}
MAX_ENTRY_LENGTH = 500

INJECTION_PATTERNS = [
    r"(?i)ignore\s+(previous|above|all)\s+instructions",
    r"(?i)you\s+are\s+now\s+",
    r"(?i)system\s*:\s*",
    r"(?i)<\s*/?system",
]


def _parse_entries(content: str) -> list[dict]:
    """Parse <!-- ENTRY --> blocks from markdown content."""
    entries = []
    blocks = content.split("<!-- ENTRY -->")
    for block in blocks[1:]:  # Skip anything before first entry
        end = block.find("<!-- /ENTRY -->")
        if end == -1:
            continue
        entry_text = block[:end].strip()
        entry = {"raw": entry_text}
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


def _sanitise_content(content: str) -> str:
    """Validate and sanitise entry content."""
    if not content or len(content) > MAX_ENTRY_LENGTH:
        raise ValueError(f"Content must be 1-{MAX_ENTRY_LENGTH} characters")
    for pattern in INJECTION_PATTERNS:
        if re.search(pattern, content):
            raise ValueError("Content contains disallowed patterns")
    content = re.sub(r"^#{1,6}\s+", "", content, flags=re.MULTILINE)
    content = re.sub(r"```[\s\S]*?```", "", content)
    return content.strip()


@app.get("/knowledge")
def list_categories():
    """List all categories with entry counts."""
    results = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET_NAME, Prefix=LEARNED_PREFIX):
        for obj in page.get("Contents", []):
            cat = obj["Key"].replace(LEARNED_PREFIX, "").replace(".md", "")
            if cat in VALID_CATEGORIES:
                try:
                    resp = s3.get_object(Bucket=BUCKET_NAME, Key=obj["Key"])
                    text = resp["Body"].read().decode("utf-8")
                    entries = _parse_entries(text)
                    results.append({"category": cat, "count": len(entries)})
                except Exception:
                    results.append({"category": cat, "count": 0})
    # Include empty categories
    found = {r["category"] for r in results}
    for cat in VALID_CATEGORIES - found:
        results.append({"category": cat, "count": 0})
    return {"categories": sorted(results, key=lambda x: x["category"])}


@app.get("/knowledge/<category>")
def list_entries(category: str):
    """List entries in a category."""
    if category not in VALID_CATEGORIES:
        return {"error": f"Invalid category: {category}"}, 400
    key = f"{LEARNED_PREFIX}{category}.md"
    try:
        resp = s3.get_object(Bucket=BUCKET_NAME, Key=key)
        text = resp["Body"].read().decode("utf-8")
        entries = _parse_entries(text)
        # Add index for edit/delete
        for i, e in enumerate(entries):
            e["index"] = i
            e.pop("raw", None)
        return {"category": category, "entries": entries}
    except s3.exceptions.NoSuchKey:
        return {"category": category, "entries": []}


@app.post("/knowledge/<category>")
def add_entry(category: str):
    """Add an entry to a category."""
    if category not in VALID_CATEGORIES:
        return {"error": f"Invalid category: {category}"}, 400
    body = app.current_event.json_body or {}
    content = _sanitise_content(body.get("content", ""))
    entry_type = body.get("type", "fact")
    if entry_type not in ("policy", "fact", "temporary", "preference"):
        entry_type = "fact"

    now = datetime.now(timezone.utc)
    months = 6 if entry_type == "policy" else 3
    review_month = now.month + months
    review_year = now.year + (review_month - 1) // 12
    review_month = ((review_month - 1) % 12) + 1
    review_date = now.replace(year=review_year, month=review_month).strftime("%Y-%m-%d")

    entry_md = (
        f"\n<!-- ENTRY -->\n"
        f"- content: {content}\n"
        f"- noted: {now.strftime('%Y-%m-%d')}\n"
        f"- source: web_ui\n"
        f"- type: {entry_type}\n"
        f"- review: {review_date}\n"
        f"<!-- /ENTRY -->\n"
    )

    key = f"{LEARNED_PREFIX}{category}.md"
    existing = ""
    try:
        resp = s3.get_object(Bucket=BUCKET_NAME, Key=key)
        existing = resp["Body"].read().decode("utf-8")
    except s3.exceptions.NoSuchKey:
        pass

    s3.put_object(
        Bucket=BUCKET_NAME, Key=key,
        Body=(existing + entry_md).encode("utf-8"),
        ContentType="text/markdown",
    )
    return {"message": "Entry added", "category": category}


@app.put("/knowledge/<category>/<index>")
def update_entry(category: str, index: str):
    """Update an entry by index."""
    if category not in VALID_CATEGORIES:
        return {"error": f"Invalid category: {category}"}, 400
    idx = int(index)
    body = app.current_event.json_body or {}
    new_content = _sanitise_content(body.get("content", ""))

    key = f"{LEARNED_PREFIX}{category}.md"
    try:
        resp = s3.get_object(Bucket=BUCKET_NAME, Key=key)
        text = resp["Body"].read().decode("utf-8")
    except s3.exceptions.NoSuchKey:
        return {"error": "Category not found"}, 404

    entries = _parse_entries(text)
    if idx < 0 or idx >= len(entries):
        return {"error": "Entry not found"}, 404

    entries[idx]["content"] = new_content
    s3.put_object(
        Bucket=BUCKET_NAME, Key=key,
        Body=_entries_to_markdown(entries).encode("utf-8"),
        ContentType="text/markdown",
    )
    return {"message": "Entry updated"}


@app.delete("/knowledge/<category>/<index>")
def delete_entry(category: str, index: str):
    """Delete an entry by index."""
    if category not in VALID_CATEGORIES:
        return {"error": f"Invalid category: {category}"}, 400
    idx = int(index)

    key = f"{LEARNED_PREFIX}{category}.md"
    try:
        resp = s3.get_object(Bucket=BUCKET_NAME, Key=key)
        text = resp["Body"].read().decode("utf-8")
    except s3.exceptions.NoSuchKey:
        return {"error": "Category not found"}, 404

    entries = _parse_entries(text)
    if idx < 0 or idx >= len(entries):
        return {"error": "Entry not found"}, 404

    entries.pop(idx)
    s3.put_object(
        Bucket=BUCKET_NAME, Key=key,
        Body=_entries_to_markdown(entries).encode("utf-8"),
        ContentType="text/markdown",
    )
    return {"message": "Entry deleted"}


@app.post("/knowledge/<category>/undo")
def undo_last_change(category: str):
    """Restore the previous version of a category file using S3 versioning."""
    if category not in VALID_CATEGORIES:
        return {"error": f"Invalid category: {category}"}, 400

    key = f"{LEARNED_PREFIX}{category}.md"
    versions = s3.list_object_versions(Bucket=BUCKET_NAME, Prefix=key)
    all_versions = versions.get("Versions", [])

    if len(all_versions) < 2:
        return {"error": "No previous version to restore"}, 400

    # all_versions[0] is current, all_versions[1] is previous
    prev = all_versions[1]
    prev_resp = s3.get_object(
        Bucket=BUCKET_NAME, Key=key, VersionId=prev["VersionId"]
    )
    prev_content = prev_resp["Body"].read()

    s3.put_object(
        Bucket=BUCKET_NAME, Key=key,
        Body=prev_content,
        ContentType="text/markdown",
    )
    return {"message": "Restored previous version"}


@logger.inject_lambda_context(correlation_id_path=API_GATEWAY_REST)
def handler(event, context: LambdaContext):
    return app.resolve(event, context)
