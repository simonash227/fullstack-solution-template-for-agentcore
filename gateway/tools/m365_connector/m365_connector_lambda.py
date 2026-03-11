"""Microsoft 365 connector Lambda for AgentCore Gateway.

Calls Microsoft Graph API using client credentials (M2M) flow.
OAuth credentials stored in Secrets Manager at /agentcore/{client-id}/microsoft365/oauth.
"""

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from urllib.request import Request, urlopen
from urllib.parse import urlencode, quote

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Cache token across Lambda invocations
_token_cache = {"access_token": None, "expires_at": 0}

GRAPH_BASE = "https://graph.microsoft.com/v1.0"


def _get_secret():
    """Fetch M365 OAuth credentials from Secrets Manager."""
    import boto3

    client = boto3.client("secretsmanager")
    resp = client.get_secret_value(SecretId=os.environ["M365_SECRET_ARN"])
    return json.loads(resp["SecretString"])


def _get_access_token():
    """Get an M365 access token using client credentials flow. Caches until expiry."""
    now = datetime.now(timezone.utc).timestamp()
    if _token_cache["access_token"] and _token_cache["expires_at"] > now + 60:
        return _token_cache["access_token"]

    creds = _get_secret()
    tenant_id = creds["tenant_id"]
    token_url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"

    data = urlencode({
        "grant_type": "client_credentials",
        "client_id": creds["client_id"],
        "client_secret": creds["client_secret"],
        "scope": "https://graph.microsoft.com/.default",
    }).encode()

    req = Request(token_url, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    with urlopen(req, timeout=10) as resp:
        token_data = json.loads(resp.read())

    _token_cache["access_token"] = token_data["access_token"]
    _token_cache["expires_at"] = now + token_data.get("expires_in", 3600)
    return _token_cache["access_token"]


def _graph_request(path, method="GET", body=None):
    """Make an authenticated request to Microsoft Graph API."""
    token = _get_access_token()
    url = f"{GRAPH_BASE}{path}"

    req = Request(url, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")

    data = json.dumps(body).encode() if body else None

    with urlopen(req, data=data, timeout=15) as resp:
        if resp.status == 204:
            return {}
        return json.loads(resp.read())


def _list_emails(event):
    user_email = event["user_email"]
    max_results = min(event.get("max_results", 10), 25)
    folder = event.get("folder", "inbox")
    search_query = event.get("search_query", "")

    path = f"/users/{quote(user_email)}/mailFolders/{folder}/messages"
    path += f"?$top={max_results}&$orderby=receivedDateTime desc"
    path += "&$select=id,subject,from,receivedDateTime,bodyPreview,isRead"

    if search_query:
        path += f"&$search=\"{search_query}\""

    data = _graph_request(path)
    messages = data.get("value", [])

    if not messages:
        return "No emails found."

    lines = []
    for m in messages:
        sender = m.get("from", {}).get("emailAddress", {})
        sender_str = f"{sender.get('name', '')} <{sender.get('address', '')}>"
        read_marker = "" if m.get("isRead") else "[UNREAD] "
        lines.append(
            f"{read_marker}**{m.get('subject', '(no subject)')}**\n"
            f"  From: {sender_str}\n"
            f"  Date: {m.get('receivedDateTime', '')}\n"
            f"  Preview: {m.get('bodyPreview', '')[:150]}\n"
            f"  ID: {m.get('id', '')}"
        )

    return f"Found {len(messages)} emails:\n\n" + "\n\n".join(lines)


def _read_email(event):
    user_email = event["user_email"]
    message_id = event["message_id"]

    path = f"/users/{quote(user_email)}/messages/{message_id}"
    path += "?$select=subject,from,toRecipients,ccRecipients,receivedDateTime,body"

    data = _graph_request(path)

    sender = data.get("from", {}).get("emailAddress", {})
    to_list = ", ".join(
        r.get("emailAddress", {}).get("address", "")
        for r in data.get("toRecipients", [])
    )
    cc_list = ", ".join(
        r.get("emailAddress", {}).get("address", "")
        for r in data.get("ccRecipients", [])
    )

    body_content = data.get("body", {}).get("content", "")
    # Strip HTML if content type is html
    if data.get("body", {}).get("contentType") == "html":
        import re
        body_content = re.sub(r"<script[^>]*>[\s\S]*?</script>", "", body_content, flags=re.IGNORECASE)
        body_content = re.sub(r"<style[^>]*>[\s\S]*?</style>", "", body_content, flags=re.IGNORECASE)
        body_content = re.sub(r"<[^>]+>", " ", body_content)
        body_content = re.sub(r"\s+", " ", body_content).strip()

    result = (
        f"**{data.get('subject', '(no subject)')}**\n"
        f"From: {sender.get('name', '')} <{sender.get('address', '')}>\n"
        f"To: {to_list}\n"
    )
    if cc_list:
        result += f"CC: {cc_list}\n"
    result += (
        f"Date: {data.get('receivedDateTime', '')}\n\n"
        f"{body_content[:5000]}"
    )

    return result


def _send_email(event):
    user_email = event["user_email"]
    to = event["to"]
    subject = event["subject"]
    body = event["body"]
    cc = event.get("cc")

    message = {
        "message": {
            "subject": subject,
            "body": {"contentType": "Text", "content": body},
            "toRecipients": [{"emailAddress": {"address": to}}],
        }
    }

    if cc:
        message["message"]["ccRecipients"] = [{"emailAddress": {"address": cc}}]

    path = f"/users/{quote(user_email)}/sendMail"
    _graph_request(path, method="POST", body=message)

    return f"Email sent successfully to {to} with subject \"{subject}\"."


def _list_calendar_events(event):
    user_email = event["user_email"]
    days_ahead = min(event.get("days_ahead", 7), 30)
    max_results = min(event.get("max_results", 10), 25)

    now = datetime.now(timezone.utc)
    end = now + timedelta(days=days_ahead)

    path = (
        f"/users/{quote(user_email)}/calendarView"
        f"?startDateTime={now.isoformat()}"
        f"&endDateTime={end.isoformat()}"
        f"&$top={max_results}"
        f"&$orderby=start/dateTime"
        f"&$select=subject,start,end,location,attendees,isAllDay"
    )

    data = _graph_request(path)
    events = data.get("value", [])

    if not events:
        return f"No calendar events in the next {days_ahead} days."

    lines = []
    for e in events:
        start = e.get("start", {})
        end_time = e.get("end", {})
        location = e.get("location", {}).get("displayName", "")
        attendees = ", ".join(
            a.get("emailAddress", {}).get("name", a.get("emailAddress", {}).get("address", ""))
            for a in e.get("attendees", [])
        )

        all_day = " (all day)" if e.get("isAllDay") else ""
        loc_str = f"\n  Location: {location}" if location else ""
        att_str = f"\n  Attendees: {attendees}" if attendees else ""

        lines.append(
            f"**{e.get('subject', '(no title)')}**{all_day}\n"
            f"  Start: {start.get('dateTime', '')}\n"
            f"  End: {end_time.get('dateTime', '')}"
            f"{loc_str}{att_str}"
        )

    return f"Found {len(events)} events in the next {days_ahead} days:\n\n" + "\n\n".join(lines)


def _search_files(event):
    search_query = event["search_query"]
    max_results = min(event.get("max_results", 10), 25)

    # Use Graph search endpoint for OneDrive/SharePoint
    body = {
        "requests": [
            {
                "entityTypes": ["driveItem"],
                "query": {"queryString": search_query},
                "from": 0,
                "size": max_results,
            }
        ]
    }

    data = _graph_request("/search/query", method="POST", body=body)

    hits = []
    for result_set in data.get("value", []):
        for hit_container in result_set.get("hitsContainers", []):
            for hit in hit_container.get("hits", []):
                resource = hit.get("resource", {})
                hits.append({
                    "name": resource.get("name", ""),
                    "web_url": resource.get("webUrl", ""),
                    "last_modified": resource.get("lastModifiedDateTime", ""),
                    "size": resource.get("size", 0),
                })

    if not hits:
        return f"No files found matching \"{search_query}\"."

    lines = []
    for f in hits:
        size_kb = f["size"] // 1024 if f["size"] else 0
        lines.append(
            f"**{f['name']}** ({size_kb} KB)\n"
            f"  Modified: {f['last_modified']}\n"
            f"  URL: {f['web_url']}"
        )

    return f"Found {len(hits)} files:\n\n" + "\n\n".join(lines)


# Tool routing table
TOOLS = {
    "list_emails": _list_emails,
    "read_email": _read_email,
    "send_email": _send_email,
    "list_calendar_events": _list_calendar_events,
    "search_files": _search_files,
}


def handler(event, context):
    """M365 connector Lambda handler for AgentCore Gateway."""
    logger.info(f"Received event: {json.dumps(event)}")

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
        logger.error(f"Error in {tool_name if 'tool_name' in dir() else 'unknown'}: {str(e)}", exc_info=True)
        return {"error": f"M365 connector error: {str(e)}"}
