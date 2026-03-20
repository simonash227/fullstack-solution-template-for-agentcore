"""WhatsApp Webhook Lambda (Steps 16d + 16f).

Handles incoming WhatsApp messages (text + voice notes), invokes the AgentCore
Runtime, and replies via Meta's Messages API. Detects approval requests in agent
responses and presents WhatsApp interactive buttons (YES/NO) for confirmation.

Environment variables:
    PHONE_NUMBER_ID: Meta WhatsApp phone number ID
    WHATSAPP_SECRET_ARN: Secrets Manager ARN for WhatsApp access token
    APP_SECRET_ARN: Secrets Manager ARN for Meta app secret (webhook signature validation)
    VERIFY_TOKEN: Webhook verification token (set during Meta webhook config)
    RUNTIME_ARN: AgentCore Runtime ARN
    COGNITO_DOMAIN: Cognito domain for token endpoint (e.g. https://xxx.auth.region.amazoncognito.com)
    MACHINE_CLIENT_ID: Cognito machine client ID
    MACHINE_CLIENT_SECRET_ARN: Secrets Manager ARN for machine client secret
    USER_MAPPINGS_TABLE: DynamoDB table for phone → user mappings
    AUDIT_TABLE: DynamoDB table for audit records
    PENDING_APPROVALS_TABLE: DynamoDB table for pending approval state (optional)
    TRANSCRIBE_LAMBDA_ARN: Transcribe Lambda ARN for voice note transcription
    OPS_BUCKET: S3 bucket for temporary voice note storage
    REGION: AWS region
"""

import hashlib
import hmac
import json
import os
import re
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import quote

import boto3
from aws_lambda_powertools import Logger
from aws_lambda_powertools.utilities.typing import LambdaContext
from botocore.exceptions import ClientError

import requests

logger = Logger()

# Environment
PHONE_NUMBER_ID = os.environ["PHONE_NUMBER_ID"]
WHATSAPP_SECRET_ARN = os.environ["WHATSAPP_SECRET_ARN"]
APP_SECRET_ARN = os.environ.get("APP_SECRET_ARN", "")
VERIFY_TOKEN = os.environ.get("VERIFY_TOKEN", "agentcore-webhook-verify")
RUNTIME_ARN = os.environ["RUNTIME_ARN"]
COGNITO_DOMAIN = os.environ["COGNITO_DOMAIN"]
MACHINE_CLIENT_ID = os.environ["MACHINE_CLIENT_ID"]
MACHINE_CLIENT_SECRET_ARN = os.environ["MACHINE_CLIENT_SECRET_ARN"]
USER_MAPPINGS_TABLE = os.environ["USER_MAPPINGS_TABLE"]
AUDIT_TABLE = os.environ.get("AUDIT_TABLE", "")
TRANSCRIBE_LAMBDA_ARN = os.environ.get("TRANSCRIBE_LAMBDA_ARN", "")
OPS_BUCKET = os.environ.get("OPS_BUCKET", "")
REGION = os.environ.get("AWS_REGION", "ap-southeast-2")

PENDING_APPROVALS_TABLE = os.environ.get("PENDING_APPROVALS_TABLE", "")

RESOURCE_SERVER_ID = os.environ.get("RESOURCE_SERVER_ID", "")
GRAPH_API_VERSION = "v21.0"
GRAPH_API_BASE = f"https://graph.facebook.com/{GRAPH_API_VERSION}"
MAX_WA_MESSAGE_LENGTH = 4096
TRUNCATE_AT = 3500

# Clients
secrets = boto3.client("secretsmanager")
dynamodb = boto3.resource("dynamodb")
lambda_client = boto3.client("lambda")
s3 = boto3.client("s3")
mappings_table = dynamodb.Table(USER_MAPPINGS_TABLE)

# Cache secrets in memory (Lambda container reuse)
_secret_cache = {}

# Message dedup — Meta retries webhooks if Lambda takes >15s to respond.
# DynamoDB-based dedup works across Lambda containers (in-memory doesn't).


def is_duplicate_message(msg_id: str) -> bool:
    """Check if we've already processed this message ID (Meta retry dedup).

    Uses a conditional DynamoDB put — first writer wins, retries get rejected.
    Stored in the pending-approvals table with a 'dedup:' key prefix.
    """
    if not PENDING_APPROVALS_TABLE or not msg_id:
        return False
    try:
        table = dynamodb.Table(PENDING_APPROVALS_TABLE)
        table.put_item(
            Item={
                "phoneNumber": f"dedup:{msg_id}",
                "ttl": int(time.time()) + 300,
            },
            ConditionExpression="attribute_not_exists(phoneNumber)",
        )
        return False  # First time — process normally
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return True  # Duplicate — skip
        logger.exception("Dedup check failed")
        return False  # On error, allow processing rather than dropping messages


def get_secret(arn: str) -> str:
    if arn not in _secret_cache:
        resp = secrets.get_secret_value(SecretId=arn)
        _secret_cache[arn] = resp["SecretString"]
    return _secret_cache[arn]


def get_access_token() -> str:
    """Get Cognito access token via client credentials flow."""
    client_secret = get_secret(MACHINE_CLIENT_SECRET_ARN)
    token_url = f"{COGNITO_DOMAIN}/oauth2/token"

    resp = requests.post(
        token_url,
        data={
            "grant_type": "client_credentials",
            "client_id": MACHINE_CLIENT_ID,
            "client_secret": client_secret,
            "scope": f"{RESOURCE_SERVER_ID}/read {RESOURCE_SERVER_ID}/write",
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


# --- Meta API helpers ---


def send_whatsapp_message(to: str, text: str) -> None:
    """Send a text message via Meta's Messages API. Splits long messages."""
    wa_token = get_secret(WHATSAPP_SECRET_ARN)
    url = f"{GRAPH_API_BASE}/{PHONE_NUMBER_ID}/messages"
    headers = {
        "Authorization": f"Bearer {wa_token}",
        "Content-Type": "application/json",
    }

    # Split long messages
    chunks = []
    if len(text) <= MAX_WA_MESSAGE_LENGTH:
        chunks = [text]
    else:
        chunks.append(text[:TRUNCATE_AT] + "\n\n_Full response available in the web app._")

    for chunk in chunks:
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": "text",
            "text": {"body": chunk},
        }
        resp = requests.post(url, headers=headers, json=payload, timeout=15)
        if not resp.ok:
            logger.error("WhatsApp send failed", status=resp.status_code, body=resp.text)


def send_approval_interactive(to: str, action_type: str, summary: str, details: str) -> None:
    """Send a WhatsApp interactive button message for approval confirmation."""
    wa_token = get_secret(WHATSAPP_SECRET_ARN)
    url = f"{GRAPH_API_BASE}/{PHONE_NUMBER_ID}/messages"
    headers = {
        "Authorization": f"Bearer {wa_token}",
        "Content-Type": "application/json",
    }

    # Build body text (WhatsApp interactive body limit: 1024 chars)
    body_text = f"*{action_type}*\n\n{summary}"
    if details:
        body_text += f"\n\n{details}"
    if len(body_text) > 1024:
        body_text = body_text[:1020] + "..."

    payload = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": to,
        "type": "interactive",
        "interactive": {
            "type": "button",
            "body": {"text": body_text},
            "action": {
                "buttons": [
                    {
                        "type": "reply",
                        "reply": {"id": "approve_yes", "title": "Yes, go ahead"},
                    },
                    {
                        "type": "reply",
                        "reply": {"id": "approve_no", "title": "No, cancel"},
                    },
                ]
            },
        },
    }

    resp = requests.post(url, headers=headers, json=payload, timeout=15)
    if not resp.ok:
        logger.error("Failed to send approval message", status=resp.status_code, body=resp.text)


# --- Approval parsing ---

APPROVAL_PATTERN = re.compile(
    r"\[APPROVAL_REQUIRED\]\s*"
    r"Action:\s*(.+?)\s*"
    r"Summary:\s*(.+?)\s*"
    r"Details:\s*(.*?)\s*"
    r"\[/APPROVAL_REQUIRED\]",
    re.DOTALL,
)


def parse_approval_request(text: str) -> dict | None:
    """Extract approval details from [APPROVAL_REQUIRED] markers in agent response."""
    match = APPROVAL_PATTERN.search(text)
    if not match:
        return None
    return {
        "actionType": match.group(1).strip(),
        "summary": match.group(2).strip(),
        "details": match.group(3).strip(),
    }


# Conversational approval patterns — agent may ask for approval as plain text
# instead of calling the request_approval tool. Check only the tail of the
# response (last 300 chars) so we detect the concluding question, not mid-text
# mentions of "approve" or "confirm".
CONVERSATIONAL_APPROVAL_PATTERNS = [
    r"(?:shall|should) I go ahead",
    r"(?:shall|should) I send",
    r"(?:shall|should) I proceed",
    r"would you like me to send",
    r"would you like me to proceed",
    r"do you want me to send",
    r"do you want me to proceed",
    r"let me know if you.d like me to send",
    r"please approve",
    r"please confirm",
    r"ready to send\?",
    r"approve or (?:let me know|reject)",
]
CONVERSATIONAL_APPROVAL_RE = re.compile(
    "|".join(CONVERSATIONAL_APPROVAL_PATTERNS), re.IGNORECASE
)


def detect_conversational_approval(text: str) -> bool:
    """Detect if the agent ends its response asking for approval conversationally."""
    # Only check the tail — avoids false positives from mid-response text
    tail = text[-300:] if len(text) > 300 else text
    return bool(CONVERSATIONAL_APPROVAL_RE.search(tail))


def _extract_action_context(text: str) -> tuple[str, str]:
    """Extract a meaningful action type and summary from the agent's response.

    Scans for keywords to determine the action type (Send Email, etc.) and
    pulls key details (recipient, amounts) into a short summary for the
    interactive button message.
    """
    lower = text.lower()

    # Detect action type
    if "email" in lower:
        action_type = "Send Email"
    elif "calendar" in lower or "event" in lower or "meeting" in lower:
        action_type = "Calendar Event"
    elif "delete" in lower or "remove" in lower:
        action_type = "Delete"
    elif "create" in lower or "record" in lower:
        action_type = "Create Record"
    else:
        action_type = "Confirm Action"

    # Extract key details for the summary
    # Look for email addresses, amounts, and recipient names
    details = []
    email_match = re.search(r"[\w.+-]+@[\w.-]+\.\w+", text)
    if email_match:
        details.append(f"To: {email_match.group()}")
    amount_match = re.search(r"\$[\d,]+(?:\.\d{2})?", text)
    if amount_match:
        details.append(amount_match.group())
    # Look for subject line
    subject_match = re.search(r"[Ss]ubject:?\s*(.+?)(?:\n|$)", text)
    if subject_match:
        details.append(f"Re: {subject_match.group(1).strip()[:60]}")

    if details:
        summary = " | ".join(details)
    else:
        # Fall back to first meaningful sentence
        summary = text.strip().split("\n")[-2][:100] if "\n" in text else text[:100]

    return action_type, summary


def strip_approval_block(text: str) -> str:
    """Remove [APPROVAL_REQUIRED] blocks and trailing approval prompt from text."""
    cleaned = APPROVAL_PATTERN.sub("", text)
    cleaned = re.sub(
        r"I need your approval before proceeding\..*$", "", cleaned, flags=re.DOTALL
    )
    return cleaned.strip()


# --- Pending approval state ---


def store_pending_approval(
    phone: str, session_id: str, user_id: str,
    action_type: str, summary: str, details: str,
) -> None:
    """Store a pending approval in DynamoDB (1-hour TTL)."""
    if not PENDING_APPROVALS_TABLE:
        return
    table = dynamodb.Table(PENDING_APPROVALS_TABLE)
    table.put_item(
        Item={
            "phoneNumber": phone,
            "sessionId": session_id,
            "userId": user_id,
            "actionType": action_type,
            "summary": summary,
            "details": details,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "ttl": int(time.time()) + 3600,
        }
    )


def get_pending_approval(phone: str) -> dict | None:
    """Retrieve a pending approval for a phone number (returns None if expired)."""
    if not PENDING_APPROVALS_TABLE:
        return None
    try:
        table = dynamodb.Table(PENDING_APPROVALS_TABLE)
        resp = table.get_item(Key={"phoneNumber": phone})
        item = resp.get("Item")
        if item and item.get("ttl", 0) > time.time():
            return item
        return None
    except ClientError:
        logger.exception("Failed to get pending approval")
        return None


def clear_pending_approval(phone: str) -> None:
    """Remove a pending approval record."""
    if not PENDING_APPROVALS_TABLE:
        return
    try:
        table = dynamodb.Table(PENDING_APPROVALS_TABLE)
        table.delete_item(Key={"phoneNumber": phone})
    except ClientError:
        logger.exception("Failed to clear pending approval")


# --- Media helpers ---


def download_whatsapp_media(media_id: str) -> bytes:
    """Download a media file (voice note) from Meta's API."""
    wa_token = get_secret(WHATSAPP_SECRET_ARN)
    headers = {"Authorization": f"Bearer {wa_token}"}

    # Step 1: Get media URL
    meta_resp = requests.get(
        f"{GRAPH_API_BASE}/{media_id}", headers=headers, timeout=10
    )
    meta_resp.raise_for_status()
    media_url = meta_resp.json()["url"]

    # Step 2: Download the file
    file_resp = requests.get(media_url, headers=headers, timeout=30)
    file_resp.raise_for_status()
    return file_resp.content


def validate_webhook_signature(body: str, signature: str) -> bool:
    """Validate Meta's X-Hub-Signature-256 header."""
    if not APP_SECRET_ARN:
        return True  # Skip validation if no app secret configured
    app_secret = get_secret(APP_SECRET_ARN)
    expected = "sha256=" + hmac.new(
        app_secret.encode(), body.encode(), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


# --- User mapping ---


def lookup_user(phone_number: str) -> dict | None:
    """Look up a WhatsApp phone number in the mappings table."""
    try:
        resp = mappings_table.get_item(Key={"phoneNumber": phone_number})
        return resp.get("Item")
    except ClientError:
        logger.exception("Failed to look up user mapping")
        return None


# --- Runtime invocation ---


def invoke_runtime(prompt: str, session_id: str, access_token: str) -> str:
    """Invoke the AgentCore Runtime and collect the full response."""
    endpoint = f"https://bedrock-agentcore.{REGION}.amazonaws.com"
    escaped_arn = quote(RUNTIME_ARN, safe="")
    url = f"{endpoint}/runtimes/{escaped_arn}/invocations?qualifier=DEFAULT"

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": session_id,
    }
    payload = {"prompt": prompt, "runtimeSessionId": session_id}

    resp = requests.post(url, headers=headers, json=payload, stream=True, timeout=120)

    if resp.status_code != 200:
        logger.error("Runtime invocation failed", status=resp.status_code, body=resp.text[:500])
        return "I'm sorry, I encountered an error processing your request. Please try again."

    # Collect text from streaming response
    text_parts = []
    for line in resp.iter_lines(decode_unicode=True):
        if not line:
            continue


        if not line.startswith("data: "):
            continue
        try:
            chunk = json.loads(line[6:])
            # Strands agent via Runtime: {"event": {"contentBlockDelta": {"delta": {"text": "..."}}}}
            event = chunk.get("event", chunk)
            delta = event.get("contentBlockDelta", {}).get("delta", {})
            if "text" in delta:
                text_parts.append(delta["text"])
            # Alternative: direct delta at top level (e.g. {"data": "...", "delta": {"text": "..."}})
            elif "delta" in chunk and "text" in chunk["delta"]:
                # Skip duplicates — only use the event-wrapped version
                pass
        except json.JSONDecodeError:
            continue

    return "".join(text_parts) or "I processed your request but have no response to show."


# --- Voice note transcription ---


def transcribe_voice_note(media_id: str) -> str:
    """Download a WhatsApp voice note, upload to S3, transcribe via Lambda."""
    # Download from Meta
    audio_data = download_whatsapp_media(media_id)
    key = f"whatsapp-voice/{uuid.uuid4().hex}.ogg"

    # Upload to ops bucket
    s3.put_object(Bucket=OPS_BUCKET, Key=key, Body=audio_data)
    s3_uri = f"s3://{OPS_BUCKET}/{key}"

    # Invoke Transcribe Lambda
    resp = lambda_client.invoke(
        FunctionName=TRANSCRIBE_LAMBDA_ARN,
        InvocationType="RequestResponse",
        Payload=json.dumps({
            "action": "transcribe_file",
            "s3_uri": s3_uri,
            "language_code": "en-AU",
        }),
    )
    result = json.loads(resp["Payload"].read())

    # Clean up the audio file
    try:
        s3.delete_object(Bucket=OPS_BUCKET, Key=key)
    except ClientError:
        pass

    if "error" in result:
        logger.error("Transcription failed", error=result["error"])
        return ""

    return result.get("transcript", "")


# --- Audit ---


def write_audit_record(
    user_id: str, session_id: str, source: str, prompt: str, response_length: int
) -> None:
    """Write an audit record for the WhatsApp interaction."""
    if not AUDIT_TABLE:
        return
    try:
        audit_table = dynamodb.Table(AUDIT_TABLE)
        now = datetime.now(timezone.utc)
        audit_table.put_item(
            Item={
                "sessionId": session_id,
                "timestamp": now.isoformat(),
                "userId": user_id,
                "datePrefix": now.strftime("%Y-%m-%d"),
                "action": "whatsapp_message",
                "source": source,
                "input": prompt[:500],
                "responseLength": response_length,
                "ttl": int(time.time()) + (7 * 365 * 24 * 3600),
            }
        )
    except ClientError:
        logger.exception("Failed to write audit record")


# --- Handler ---


@logger.inject_lambda_context
def handler(event: dict, context: LambdaContext) -> dict:
    """Handle API Gateway events for WhatsApp webhook."""

    http_method = event.get("httpMethod", "")
    path = event.get("path", "")

    # GET: Webhook verification challenge
    if http_method == "GET":
        params = event.get("queryStringParameters") or {}
        mode = params.get("hub.mode")
        token = params.get("hub.verify_token")
        challenge = params.get("hub.challenge")

        if mode == "subscribe" and token == VERIFY_TOKEN:
            logger.info("Webhook verified")
            return {
                "statusCode": 200,
                "body": challenge,
                "headers": {"Content-Type": "text/plain"},
            }
        return {"statusCode": 403, "body": "Forbidden"}

    # POST: Incoming messages
    if http_method == "POST":
        body = event.get("body", "")

        # Validate signature
        signature = (event.get("headers") or {}).get("X-Hub-Signature-256", "")
        if not validate_webhook_signature(body, signature):
            logger.warning("Invalid webhook signature")
            return {"statusCode": 403, "body": "Invalid signature"}

        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            return {"statusCode": 400, "body": "Invalid JSON"}

        # Process each message
        for entry in data.get("entry", []):
            for change in entry.get("changes", []):
                value = change.get("value", {})
                messages = value.get("messages", [])

                for message in messages:
                    process_message(message)

        # Always return 200 to Meta (they retry on non-200)
        return {"statusCode": 200, "body": "OK"}

    return {"statusCode": 405, "body": "Method not allowed"}


def process_message(message: dict) -> None:
    """Process a single incoming WhatsApp message."""
    sender = message.get("from", "")
    msg_type = message.get("type", "")
    msg_id = message.get("id", "")

    logger.info("Processing message", sender=sender, type=msg_type, id=msg_id)

    # Dedup: Meta retries webhooks if we take >15s — skip already-processed messages
    if msg_id and is_duplicate_message(msg_id):
        logger.info("Skipping duplicate message", id=msg_id)
        return

    # Look up user
    user = lookup_user(sender)
    if not user:
        send_whatsapp_message(
            sender,
            "This number is not registered. Please contact your administrator.",
        )
        return

    user_id = user["userId"]

    # Handle interactive button replies (approval responses)
    if msg_type == "interactive":
        interactive = message.get("interactive", {})
        if interactive.get("type") == "button_reply":
            handle_approval_response(sender, user_id, interactive["button_reply"])
            return

    # If user sends a new message while approval is pending, clear stale approval
    pending = get_pending_approval(sender)
    if pending:
        clear_pending_approval(sender)
        logger.info("Cleared stale pending approval", phone=sender)

    # Deterministic session ID per user per day — enables multi-turn conversations.
    # All messages from the same phone on the same day share one session,
    # so AgentCore Memory provides conversation continuity.
    # Runtime requires runtimeSessionId >= 33 chars.
    session_id = f"whatsapp-{sender}-{datetime.now(timezone.utc).strftime('%Y%m%d')}-daily"

    # Extract prompt
    prompt = ""
    source = "whatsapp_text"

    if msg_type == "text":
        prompt = message.get("text", {}).get("body", "")
    elif msg_type == "audio":
        media_id = message.get("audio", {}).get("id", "")
        if media_id and TRANSCRIBE_LAMBDA_ARN:
            prompt = transcribe_voice_note(media_id)
            source = "whatsapp_voice"
            if not prompt:
                send_whatsapp_message(
                    sender, "Sorry, I couldn't understand that voice message. Please try again."
                )
                return
        else:
            send_whatsapp_message(
                sender, "Voice messages are not enabled. Please send a text message."
            )
            return
    else:
        # Unsupported message type (image, sticker, etc.)
        send_whatsapp_message(
            sender,
            "I can only process text and voice messages at this time.",
        )
        return

    if not prompt.strip():
        return

    # Invoke the agent
    try:
        access_token = get_access_token()
        response_text = invoke_runtime(prompt, session_id, access_token)

        # Check for approval request in response (tool-based or conversational)
        approval = parse_approval_request(response_text)
        if approval and PENDING_APPROVALS_TABLE:
            # Tool-based: agent called request_approval with structured data
            store_pending_approval(
                sender, session_id, user_id,
                approval["actionType"], approval["summary"], approval["details"],
            )
            preamble = strip_approval_block(response_text)
            if preamble:
                send_whatsapp_message(sender, preamble)
            send_approval_interactive(
                sender, approval["actionType"], approval["summary"], approval["details"],
            )
        elif detect_conversational_approval(response_text) and PENDING_APPROVALS_TABLE:
            # Conversational: agent asked "Shall I go ahead?" as plain text.
            # Extract action type and a summary from the response for the buttons.
            action_type, summary = _extract_action_context(response_text)
            store_pending_approval(
                sender, session_id, user_id,
                action_type, summary, "",
            )
            # Send the full response as text, then follow up with buttons
            send_whatsapp_message(sender, response_text)
            send_approval_interactive(sender, action_type, summary, "")
        else:
            send_whatsapp_message(sender, response_text)

        # Audit
        write_audit_record(user_id, session_id, source, prompt, len(response_text))

    except Exception:
        logger.exception("Failed to process message")
        send_whatsapp_message(
            sender, "I'm sorry, something went wrong. Please try again in a moment."
        )


def handle_approval_response(sender: str, user_id: str, button_reply: dict) -> None:
    """Handle a user's YES/NO button tap on an approval request."""
    button_id = button_reply.get("id", "")

    pending = get_pending_approval(sender)
    if not pending:
        send_whatsapp_message(
            sender,
            "No pending approval found. The request may have expired — please try again.",
        )
        return

    session_id = pending["sessionId"]
    clear_pending_approval(sender)

    if button_id == "approve_yes":
        prompt = "Approved. Go ahead."
    else:
        prompt = "Rejected. Do not proceed with this action."

    # Resume the agent session with the same session ID
    try:
        access_token = get_access_token()
        response_text = invoke_runtime(prompt, session_id, access_token)
        send_whatsapp_message(sender, response_text)

        source = f"whatsapp_approval_{button_id}"
        write_audit_record(user_id, session_id, source, prompt, len(response_text))

    except Exception:
        logger.exception("Failed to resume after approval response")
        send_whatsapp_message(
            sender,
            "I'm sorry, something went wrong processing your response. Please try again.",
        )
