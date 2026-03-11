"""Documents API Lambda Handler — list, upload, download, delete documents."""

import os
import urllib.parse
from typing import Any, Dict

import boto3
from aws_lambda_powertools import Logger
from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig
from aws_lambda_powertools.logging.correlation_paths import API_GATEWAY_REST
from aws_lambda_powertools.utilities.typing import LambdaContext
from botocore.exceptions import ClientError

BUCKET_NAME = os.environ["BUCKET_NAME"]
KMS_KEY_ARN = os.environ.get("KMS_KEY_ARN", "")
KNOWLEDGE_BASE_ID = os.environ["KNOWLEDGE_BASE_ID"]
DATA_SOURCE_ID = os.environ["DATA_SOURCE_ID"]
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

from botocore.config import Config as BotoConfig

# S3 client must use SigV4 for presigned URLs with KMS SSE
s3 = boto3.client("s3", config=BotoConfig(signature_version="s3v4"))
bedrock_agent = boto3.client("bedrock-agent")
logger = Logger()
app = APIGatewayRestResolver(cors=cors_config)

# Presigned URL expiry
UPLOAD_URL_EXPIRY = 3600  # 1 hour
DOWNLOAD_URL_EXPIRY = 900  # 15 minutes

ALLOWED_EXTENSIONS = {
    ".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt",
    ".txt", ".csv", ".md", ".rtf", ".html", ".htm", ".json",
}


def _validate_filename(filename: str) -> str:
    """Validate and sanitise a filename."""
    if not filename or not filename.strip():
        raise ValueError("Filename is required")
    # Remove path separators to prevent directory traversal
    name = filename.replace("\\", "/").split("/")[-1].strip()
    if not name:
        raise ValueError("Invalid filename")
    ext = os.path.splitext(name)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise ValueError(
            f"File type '{ext}' not allowed. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
        )
    return name


@app.get("/documents")
def list_documents() -> Dict[str, Any]:
    """List all documents in the S3 bucket."""
    try:
        paginator = s3.get_paginator("list_objects_v2")
        documents = []

        for page in paginator.paginate(Bucket=BUCKET_NAME):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                # Skip hidden/system files
                if key.startswith(".") or key.startswith("_"):
                    continue
                ext = os.path.splitext(key)[1].lower()
                documents.append({
                    "key": key,
                    "name": key.split("/")[-1],
                    "size": obj["Size"],
                    "lastModified": obj["LastModified"].isoformat(),
                    "type": ext.lstrip(".").upper() if ext else "FILE",
                })

        # Sort by lastModified descending (newest first)
        documents.sort(key=lambda d: d["lastModified"], reverse=True)
        return {"documents": documents}

    except ClientError as e:
        logger.error(f"S3 list error: {e}")
        return {"error": "Failed to list documents"}, 500


@app.post("/documents/upload-url")
def generate_upload_url() -> Dict[str, Any]:
    """Generate a presigned URL for direct S3 upload."""
    try:
        body = app.current_event.json_body
        filename = _validate_filename(body.get("filename", ""))
        content_type = body.get("contentType", "application/octet-stream")

        # Don't include SSE params — the bucket's default KMS encryption handles it
        url = s3.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": BUCKET_NAME,
                "Key": filename,
                "ContentType": content_type,
            },
            ExpiresIn=UPLOAD_URL_EXPIRY,
        )

        return {"uploadUrl": url, "key": filename}

    except ValueError as e:
        return {"error": str(e)}, 400
    except ClientError as e:
        logger.error(f"Presigned URL error: {e}")
        return {"error": "Failed to generate upload URL"}, 500


@app.post("/documents/download-url")
def generate_download_url() -> Dict[str, Any]:
    """Generate a presigned URL for downloading a document."""
    try:
        body = app.current_event.json_body
        key = body.get("key", "").strip()
        if not key:
            return {"error": "key is required"}, 400

        url = s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": BUCKET_NAME, "Key": key},
            ExpiresIn=DOWNLOAD_URL_EXPIRY,
        )

        return {"downloadUrl": url}

    except ClientError as e:
        logger.error(f"Download URL error: {e}")
        return {"error": "Failed to generate download URL"}, 500


@app.delete("/documents/<key>")
def delete_document(key: str) -> Dict[str, Any]:
    """Delete a document from S3 and trigger KB re-sync."""
    try:
        decoded_key = urllib.parse.unquote(key)
        if not decoded_key:
            return {"error": "Document key is required"}, 400

        # Delete the object (S3 versioning preserves old versions as safety net)
        s3.delete_object(Bucket=BUCKET_NAME, Key=decoded_key)
        logger.info(f"Deleted document: {decoded_key}")

        # Trigger KB ingestion to remove deleted document's vectors
        _trigger_ingestion()

        return {"success": True, "key": decoded_key}

    except ClientError as e:
        logger.error(f"Delete error: {e}")
        return {"error": "Failed to delete document"}, 500


@app.post("/documents/sync")
def trigger_sync() -> Dict[str, Any]:
    """Manually trigger KB ingestion job."""
    try:
        job_id = _trigger_ingestion()
        return {"success": True, "ingestionJobId": job_id}
    except Exception as e:
        logger.error(f"Sync error: {e}")
        return {"error": "Failed to trigger sync"}, 500


def _trigger_ingestion() -> str:
    """Start a Knowledge Base ingestion job."""
    response = bedrock_agent.start_ingestion_job(
        knowledgeBaseId=KNOWLEDGE_BASE_ID,
        dataSourceId=DATA_SOURCE_ID,
    )
    job_id = response["ingestionJob"]["ingestionJobId"]
    logger.info(f"KB ingestion job started: {job_id}")
    return job_id


@logger.inject_lambda_context(correlation_id_path=API_GATEWAY_REST)
def handler(event: dict, context: LambdaContext) -> dict:
    return app.resolve(event, context)
