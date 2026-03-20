"""Transcribe API Lambda — presigned WebSocket URL + batch transcription."""

import datetime
import hashlib
import hmac
import json
import os
import time
import urllib.parse
import uuid

import boto3
from aws_lambda_powertools import Logger
from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig
from aws_lambda_powertools.logging.correlation_paths import API_GATEWAY_REST
from aws_lambda_powertools.utilities.typing import LambdaContext
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "ap-southeast-2")
CORS_ALLOWED_ORIGINS = os.environ.get("CORS_ALLOWED_ORIGINS", "*")
DEFAULT_LANGUAGE = os.environ.get("DEFAULT_LANGUAGE", "en-AU")
OPS_BUCKET = os.environ.get("OPS_BUCKET", "")
DATA_ACCESS_ROLE_ARN = os.environ.get("DATA_ACCESS_ROLE_ARN", "")

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

transcribe = boto3.client("transcribe")
s3 = boto3.client("s3")
logger = Logger()
app = APIGatewayRestResolver(cors=cors_config)

# Presigned URL expiry (seconds)
PRESIGNED_URL_EXPIRY = 300

# Batch transcription polling
POLL_INTERVAL = 2
MAX_POLL_TIME = 120

# Media format mapping from file extension
MEDIA_FORMATS = {
    ".ogg": "ogg",
    ".opus": "ogg",
    ".mp3": "mp3",
    ".mp4": "mp4",
    ".m4a": "mp4",
    ".flac": "flac",
    ".wav": "wav",
    ".webm": "webm",
    ".amr": "amr",
}


# --- SigV4 presigned URL for Transcribe streaming ---


def _sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _get_signature_key(
    secret_key: str, date_stamp: str, region: str, service: str
) -> bytes:
    k_date = _sign(f"AWS4{secret_key}".encode("utf-8"), date_stamp)
    k_region = _sign(k_date, region)
    k_service = _sign(k_region, service)
    return _sign(k_service, "aws4_request")


def create_presigned_url(
    region: str,
    language_code: str = "en-AU",
    media_encoding: str = "pcm",
    sample_rate: int = 16000,
    expires: int = PRESIGNED_URL_EXPIRY,
) -> str:
    """Generate a SigV4-signed presigned WebSocket URL for Transcribe streaming."""
    session = boto3.Session()
    credentials = session.get_credentials().get_frozen_credentials()

    endpoint = f"transcribestreaming.{region}.amazonaws.com:8443"
    path = "/stream-transcription-websocket"

    now = datetime.datetime.utcnow()
    datestamp = now.strftime("%Y%m%d")
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")

    credential_scope = f"{datestamp}/{region}/transcribe/aws4_request"

    params = {
        "language-code": language_code,
        "media-encoding": media_encoding,
        "sample-rate": str(sample_rate),
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": f"{credentials.access_key}/{credential_scope}",
        "X-Amz-Date": amz_date,
        "X-Amz-Expires": str(expires),
        "X-Amz-SignedHeaders": "host",
    }
    if credentials.token:
        params["X-Amz-Security-Token"] = credentials.token

    canonical_querystring = "&".join(
        f"{urllib.parse.quote(k, safe='')}={urllib.parse.quote(v, safe='')}"
        for k, v in sorted(params.items())
    )
    canonical_headers = f"host:{endpoint}\n"
    payload_hash = hashlib.sha256(b"").hexdigest()

    canonical_request = (
        f"GET\n{path}\n{canonical_querystring}\n"
        f"{canonical_headers}\nhost\n{payload_hash}"
    )

    string_to_sign = (
        f"AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n"
        f"{hashlib.sha256(canonical_request.encode('utf-8')).hexdigest()}"
    )

    signing_key = _get_signature_key(
        credentials.secret_key, datestamp, region, "transcribe"
    )
    signature = hmac.new(
        signing_key, string_to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    return f"wss://{endpoint}{path}?{canonical_querystring}&X-Amz-Signature={signature}"


# --- Batch transcription (for WhatsApp voice notes via direct Lambda invoke) ---


def transcribe_file(s3_uri: str, language_code: str = None) -> dict:
    """Batch-transcribe an audio file from S3. Returns {"transcript": "..."}."""
    language_code = language_code or DEFAULT_LANGUAGE

    # Detect media format from extension
    ext = os.path.splitext(s3_uri.lower())[1]
    media_format = MEDIA_FORMATS.get(ext)

    job_name = f"agentcore-{uuid.uuid4().hex[:12]}"
    job_params = {
        "TranscriptionJobName": job_name,
        "LanguageCode": language_code,
        "Media": {"MediaFileUri": s3_uri},
    }
    if media_format:
        job_params["MediaFormat"] = media_format
    # Use Lambda's own role so Transcribe can access KMS-encrypted S3 objects
    if DATA_ACCESS_ROLE_ARN:
        job_params["JobExecutionSettings"] = {
            "AllowDeferredExecution": False,
            "DataAccessRoleArn": DATA_ACCESS_ROLE_ARN,
        }

    logger.info("Starting transcription job", job_name=job_name, s3_uri=s3_uri)
    transcribe.start_transcription_job(**job_params)

    # Poll until complete
    elapsed = 0
    while elapsed < MAX_POLL_TIME:
        time.sleep(POLL_INTERVAL)
        elapsed += POLL_INTERVAL

        response = transcribe.get_transcription_job(TranscriptionJobName=job_name)
        status = response["TranscriptionJob"]["TranscriptionJobStatus"]

        if status == "COMPLETED":
            transcript_uri = response["TranscriptionJob"]["Transcript"][
                "TranscriptFileUri"
            ]
            # Fetch the transcript JSON from the Transcribe-managed S3 location
            transcript_response = boto3.client("s3").get_object(
                **_parse_s3_uri(transcript_uri)
            )
            transcript_json = json.loads(
                transcript_response["Body"].read().decode("utf-8")
            )
            text = transcript_json["results"]["transcripts"][0]["transcript"]

            # Clean up the job
            try:
                transcribe.delete_transcription_job(TranscriptionJobName=job_name)
            except ClientError:
                pass

            logger.info("Transcription complete", job_name=job_name, length=len(text))
            return {"transcript": text}

        if status == "FAILED":
            reason = response["TranscriptionJob"].get("FailureReason", "Unknown")
            logger.error("Transcription failed", job_name=job_name, reason=reason)
            return {"error": f"Transcription failed: {reason}"}

    logger.error("Transcription timed out", job_name=job_name)
    return {"error": "Transcription timed out"}


def _parse_s3_uri(uri: str) -> dict:
    """Parse s3://bucket/key or https://s3...amazonaws.com/.../key into Bucket+Key."""
    if uri.startswith("s3://"):
        parts = uri[5:].split("/", 1)
        return {"Bucket": parts[0], "Key": parts[1]}
    # Transcribe returns https URLs for its output
    parsed = urllib.parse.urlparse(uri)
    # Format: https://s3.{region}.amazonaws.com/{bucket}/{key}
    path_parts = parsed.path.lstrip("/").split("/", 1)
    return {"Bucket": path_parts[0], "Key": path_parts[1]}


# --- API Gateway endpoint ---


@app.get("/transcribe/presigned-url")
def get_presigned_url():
    """Generate a presigned WebSocket URL for Transcribe streaming."""
    language_code = app.current_event.get_query_string_value(
        "language_code", DEFAULT_LANGUAGE
    )
    sample_rate = int(
        app.current_event.get_query_string_value("sample_rate", "16000")
    )

    url = create_presigned_url(
        region=REGION,
        language_code=language_code,
        sample_rate=sample_rate,
    )

    return {"url": url, "expires_in": PRESIGNED_URL_EXPIRY}


@app.post("/transcribe/audio")
def transcribe_audio():
    """Receive base64-encoded audio, upload to S3, batch transcribe with DataAccessRole."""
    import base64

    body = app.current_event.json_body
    audio_b64 = body.get("audio", "")
    audio_format = body.get("format", "webm")
    language_code = body.get("language_code", DEFAULT_LANGUAGE)

    if not audio_b64:
        return {"error": "No audio data provided"}, 400

    if not OPS_BUCKET:
        return {"error": "Transcription not configured"}, 500

    audio_data = base64.b64decode(audio_b64)
    logger.info("Transcribing audio", size=len(audio_data))

    key = f"voice-input/{uuid.uuid4().hex}.{audio_format}"
    s3.put_object(Bucket=OPS_BUCKET, Key=key, Body=audio_data)
    s3_uri = f"s3://{OPS_BUCKET}/{key}"

    # Batch transcribe using Lambda's own role (has S3+KMS access)
    job_name = f"agentcore-{uuid.uuid4().hex[:12]}"
    job_params = {
        "TranscriptionJobName": job_name,
        "LanguageCode": language_code,
        "Media": {"MediaFileUri": s3_uri},
        "MediaFormat": audio_format,
        "OutputBucketName": OPS_BUCKET,
        "OutputKey": f"voice-output/{job_name}.json",
    }
    if DATA_ACCESS_ROLE_ARN:
        job_params["JobExecutionSettings"] = {
            "AllowDeferredExecution": False,
            "DataAccessRoleArn": DATA_ACCESS_ROLE_ARN,
        }

    logger.info("Starting transcription job", job_name=job_name, s3_uri=s3_uri)
    transcribe.start_transcription_job(**job_params)

    # Poll until complete
    elapsed = 0
    while elapsed < MAX_POLL_TIME:
        time.sleep(POLL_INTERVAL)
        elapsed += POLL_INTERVAL

        response = transcribe.get_transcription_job(TranscriptionJobName=job_name)
        status = response["TranscriptionJob"]["TranscriptionJobStatus"]

        if status == "COMPLETED":
            # Read output from our own bucket (Lambda has access)
            out_resp = s3.get_object(
                Bucket=OPS_BUCKET, Key=f"voice-output/{job_name}.json"
            )
            transcript_json = json.loads(out_resp["Body"].read().decode("utf-8"))
            text = transcript_json["results"]["transcripts"][0]["transcript"]

            # Clean up
            for k in [key, f"voice-output/{job_name}.json"]:
                try:
                    s3.delete_object(Bucket=OPS_BUCKET, Key=k)
                except ClientError:
                    pass
            try:
                transcribe.delete_transcription_job(TranscriptionJobName=job_name)
            except ClientError:
                pass

            logger.info("Transcription complete", length=len(text))
            return {"transcript": text}

        if status == "FAILED":
            reason = response["TranscriptionJob"].get("FailureReason", "Unknown")
            logger.error("Transcription failed", reason=reason)
            try:
                s3.delete_object(Bucket=OPS_BUCKET, Key=key)
            except ClientError:
                pass
            return {"error": f"Transcription failed: {reason}"}

    return {"error": "Transcription timed out"}


# --- Handler ---


@logger.inject_lambda_context(correlation_id_path=API_GATEWAY_REST)
def handler(event: dict, context: LambdaContext) -> dict:
    # Direct Lambda invocation (from WhatsApp webhook)
    if "action" in event and event["action"] == "transcribe_file":
        return transcribe_file(
            s3_uri=event["s3_uri"],
            language_code=event.get("language_code"),
        )

    # API Gateway invocation
    return app.resolve(event, context)
