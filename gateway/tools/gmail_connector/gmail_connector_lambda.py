"""Gmail connector Lambda for AgentCore Gateway.

Uses OAuth2 refresh token flow to access Gmail API.
Credentials stored in Secrets Manager at /agentcore/{client-id}/gmail/oauth.
"""

import base64
import json
import logging
import os
from email.mime.text import MIMEText
from urllib.request import Request, urlopen
from urllib.parse import urlencode

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Cache token across Lambda invocations
_token_cache = {"access_token": None, "expires_at": 0}

GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"


def _get_secret():
    """Fetch Gmail OAuth credentials from Secrets Manager."""
    import boto3

    client = boto3.client("secretsmanager")
    resp = client.get_secret_value(SecretId=os.environ["GMAIL_SECRET_ARN"])
    return json.loads(resp["SecretString"])


def _get_access_token():
    """Get a Gmail access token using refresh token flow. Caches until expiry."""
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).timestamp()
    if _token_cache["access_token"] and _token_cache["expires_at"] > now + 60:
        return _token_cache["access_token"]

    creds = _get_secret()

    data = urlencode({
        "grant_type": "refresh_token",
        "client_id": creds["client_id"],
        "client_secret": creds["client_secret"],
        "refresh_token": creds["refresh_token"],
    }).encode()

    req = Request("https://oauth2.googleapis.com/token", data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    with urlopen(req, timeout=10) as resp:
        token_data = json.loads(resp.read())

    _token_cache["access_token"] = token_data["access_token"]
    _token_cache["expires_at"] = now + token_data.get("expires_in", 3600)
    return _token_cache["access_token"]


def _gmail_request(path, method="GET", body=None):
    """Make an authenticated request to Gmail API."""
    token = _get_access_token()
    url = f"{GMAIL_BASE}{path}"

    req = Request(url, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")

    data = json.dumps(body).encode() if body else None

    with urlopen(req, data=data, timeout=15) as resp:
        if resp.status == 204:
            return {}
        return json.loads(resp.read())


def _get_header(headers, name):
    """Extract a header value from Gmail message headers."""
    for h in headers:
        if h["name"].lower() == name.lower():
            return h["value"]
    return ""


def _decode_body(payload):
    """Extract plain text body from Gmail message payload."""
    # Simple message
    if payload.get("mimeType") == "text/plain" and payload.get("body", {}).get("data"):
        return base64.urlsafe_b64decode(payload["body"]["data"]).decode("utf-8", errors="replace")

    # Multipart — find text/plain part
    for part in payload.get("parts", []):
        if part.get("mimeType") == "text/plain" and part.get("body", {}).get("data"):
            return base64.urlsafe_b64decode(part["body"]["data"]).decode("utf-8", errors="replace")
        # Nested multipart
        if part.get("parts"):
            result = _decode_body(part)
            if result:
                return result

    # Fallback: try text/html
    for part in payload.get("parts", []):
        if part.get("mimeType") == "text/html" and part.get("body", {}).get("data"):
            import re
            html = base64.urlsafe_b64decode(part["body"]["data"]).decode("utf-8", errors="replace")
            text = re.sub(r"<script[^>]*>[\s\S]*?</script>", "", html, flags=re.IGNORECASE)
            text = re.sub(r"<style[^>]*>[\s\S]*?</style>", "", text, flags=re.IGNORECASE)
            text = re.sub(r"<[^>]+>", " ", text)
            text = re.sub(r"\s+", " ", text).strip()
            return text

    return "(no readable content)"


def _list_emails(event):
    max_results = min(event.get("max_results", 10), 25)
    search_query = event.get("search_query", "")

    path = f"/messages?maxResults={max_results}"
    if search_query:
        path += f"&q={urlencode({'': search_query})[1:]}"

    data = _gmail_request(path)
    message_ids = data.get("messages", [])

    if not message_ids:
        return "No emails found."

    lines = []
    for msg_ref in message_ids:
        msg = _gmail_request(f"/messages/{msg_ref['id']}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date")
        headers = msg.get("payload", {}).get("headers", [])
        subject = _get_header(headers, "Subject") or "(no subject)"
        sender = _get_header(headers, "From")
        date = _get_header(headers, "Date")
        snippet = msg.get("snippet", "")
        unread = "UNREAD" in msg.get("labelIds", [])
        read_marker = "[UNREAD] " if unread else ""

        lines.append(
            f"{read_marker}**{subject}**\n"
            f"  From: {sender}\n"
            f"  Date: {date}\n"
            f"  Preview: {snippet[:150]}\n"
            f"  ID: {msg_ref['id']}"
        )

    return f"Found {len(lines)} emails:\n\n" + "\n\n".join(lines)


def _read_email(event):
    message_id = event["message_id"]

    msg = _gmail_request(f"/messages/{message_id}?format=full")
    headers = msg.get("payload", {}).get("headers", [])

    subject = _get_header(headers, "Subject") or "(no subject)"
    sender = _get_header(headers, "From")
    to = _get_header(headers, "To")
    cc = _get_header(headers, "Cc")
    date = _get_header(headers, "Date")

    body = _decode_body(msg.get("payload", {}))

    result = (
        f"**{subject}**\n"
        f"From: {sender}\n"
        f"To: {to}\n"
    )
    if cc:
        result += f"CC: {cc}\n"
    result += f"Date: {date}\n\n{body[:5000]}"

    return result


def _send_email(event):
    to = event["to"]
    subject = event["subject"]
    body = event["body"]
    cc = event.get("cc")

    msg = MIMEText(body)
    msg["To"] = to
    msg["Subject"] = subject
    if cc:
        msg["Cc"] = cc

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")

    _gmail_request("/messages/send", method="POST", body={"raw": raw})

    return f"Email sent successfully to {to} with subject \"{subject}\"."


# Tool routing table
TOOLS = {
    "gmail_list_emails": _list_emails,
    "gmail_read_email": _read_email,
    "gmail_send_email": _send_email,
}


def handler(event, context):
    """Gmail connector Lambda handler for AgentCore Gateway."""
    logger.info(f"Received event: {json.dumps(event)}")

    tool_name = None
    try:
        delimiter = "___"
        original_tool_name = context.client_context.custom["bedrockAgentCoreToolName"]
        tool_name = original_tool_name[
            original_tool_name.index(delimiter) + len(delimiter) :
        ]

        tool_fn = TOOLS.get(tool_name)
        if not tool_fn:
            return {"error": f"Unknown tool: {tool_name}. Available: {', '.join(TOOLS.keys())}"}

        result = tool_fn(event)

        return {
            "content": [{"type": "text", "text": result}],
        }

    except Exception as e:
        logger.error(f"Error in {tool_name or 'unknown'}: {str(e)}", exc_info=True)
        return {"error": f"Gmail connector error: {str(e)}"}
