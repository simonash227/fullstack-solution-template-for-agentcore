"""Slack connector Lambda for AgentCore Gateway.

Uses Bot token (xoxb-) for most operations and User token (xoxp-) for search.
Credentials stored in Secrets Manager at /agentcore/{client-id}/slack/oauth.

Bot tokens do not expire by default. If token rotation is enabled,
this connector does NOT handle refresh — use non-rotating tokens.
"""

import json
import logging
import os
from urllib.parse import urlencode
from urllib.request import Request, urlopen

logger = logging.getLogger()
logger.setLevel(logging.INFO)

SLACK_API_BASE = "https://slack.com/api"

# Cache secrets across Lambda invocations
_secret_cache = None


def _get_secret():
    """Fetch Slack credentials from Secrets Manager."""
    global _secret_cache
    if _secret_cache:
        return _secret_cache

    import boto3

    client = boto3.client("secretsmanager")
    resp = client.get_secret_value(SecretId=os.environ["SLACK_SECRET_ARN"])
    _secret_cache = json.loads(resp["SecretString"])
    return _secret_cache


def _slack_request(method, params=None, body=None, use_user_token=False):
    """Make an authenticated request to the Slack Web API."""
    creds = _get_secret()
    token = creds["user_token"] if use_user_token else creds["bot_token"]

    url = f"{SLACK_API_BASE}/{method}"

    if body is not None:
        # POST with JSON body
        req = Request(url, method="POST")
        req.add_header("Content-Type", "application/json; charset=utf-8")
        data = json.dumps(body).encode("utf-8")
    elif params:
        # GET with query params
        url += "?" + urlencode(params)
        req = Request(url, method="GET")
        data = None
    else:
        req = Request(url, method="GET")
        data = None

    req.add_header("Authorization", f"Bearer {token}")

    with urlopen(req, data=data, timeout=15) as resp:
        result = json.loads(resp.read())

    if not result.get("ok"):
        error = result.get("error", "unknown_error")
        logger.error(f"Slack API error: {error} for {method}")
        raise Exception(f"Slack API error: {error}")

    return result


def _format_user(user_cache, user_id):
    """Get a display name for a user ID."""
    if user_id in user_cache:
        return user_cache[user_id]
    try:
        resp = _slack_request("users.info", params={"user": user_id})
        profile = resp["user"]["profile"]
        name = profile.get("real_name") or profile.get("display_name") or resp["user"].get("name", user_id)
        user_cache[user_id] = name
        return name
    except Exception:
        return user_id


# --- Tool implementations ---


def _list_channels(event):
    include_private = event.get("include_private", True)
    max_results = min(event.get("max_results", 20), 100)

    types = "public_channel,private_channel" if include_private else "public_channel"
    params = {
        "types": types,
        "exclude_archived": "true",
        "limit": str(max_results),
    }

    data = _slack_request("conversations.list", params=params)
    channels = data.get("channels", [])

    if not channels:
        return "No channels found."

    lines = []
    for ch in channels:
        name = ch.get("name", "unknown")
        ch_id = ch["id"]
        is_private = ch.get("is_private", False)
        purpose = ch.get("purpose", {}).get("value", "")
        members = ch.get("num_members", "?")
        lock = " [private]" if is_private else ""

        line = f"**#{name}**{lock} ({ch_id}) — {members} members"
        if purpose:
            line += f"\n  Purpose: {purpose[:100]}"
        lines.append(line)

    return f"Found {len(lines)} channel(s):\n\n" + "\n\n".join(lines)


def _read_messages(event):
    channel_id = event["channel_id"]
    max_results = min(event.get("max_results", 15), 50)

    params = {
        "channel": channel_id,
        "limit": str(max_results),
    }

    data = _slack_request("conversations.history", params=params)
    messages = data.get("messages", [])

    if not messages:
        return "No messages found in this channel."

    user_cache = {}
    lines = []
    for msg in reversed(messages):  # Chronological order
        user_id = msg.get("user", "")
        text = msg.get("text", "")
        ts = msg.get("ts", "")

        # Convert timestamp to readable format
        from datetime import datetime, timezone
        try:
            dt = datetime.fromtimestamp(float(ts), tz=timezone.utc)
            time_str = dt.strftime("%Y-%m-%d %H:%M")
        except (ValueError, OSError):
            time_str = ts

        name = _format_user(user_cache, user_id) if user_id else "system"

        # Truncate very long messages
        if len(text) > 500:
            text = text[:500] + "..."

        lines.append(f"**{name}** ({time_str}):\n{text}")

    return f"Last {len(lines)} messages:\n\n" + "\n\n".join(lines)


def _search(event):
    query = event["query"]
    max_results = min(event.get("max_results", 10), 50)
    sort = event.get("sort", "score")

    params = {
        "query": query,
        "count": str(max_results),
        "sort": sort,
        "sort_dir": "desc",
    }

    # search.messages requires a user token
    data = _slack_request("search.messages", params=params, use_user_token=True)
    matches = data.get("messages", {}).get("matches", [])
    total = data.get("messages", {}).get("total", 0)

    if not matches:
        return f"No messages found matching '{query}'."

    lines = []
    for m in matches:
        text = m.get("text", "")
        username = m.get("username", "unknown")
        channel_name = m.get("channel", {}).get("name", "unknown")
        ts = m.get("ts", "")
        permalink = m.get("permalink", "")

        from datetime import datetime, timezone
        try:
            dt = datetime.fromtimestamp(float(ts), tz=timezone.utc)
            time_str = dt.strftime("%Y-%m-%d %H:%M")
        except (ValueError, OSError):
            time_str = ts

        if len(text) > 300:
            text = text[:300] + "..."

        lines.append(
            f"**{username}** in #{channel_name} ({time_str}):\n{text}"
        )

    return f"Found {total} result(s) for '{query}' (showing {len(lines)}):\n\n" + "\n\n".join(lines)


def _send_message(event):
    channel_id = event["channel_id"]
    text = event["text"]
    thread_ts = event.get("thread_ts")

    body = {"channel": channel_id, "text": text}
    if thread_ts:
        body["thread_ts"] = thread_ts

    data = _slack_request("chat.postMessage", body=body)
    channel = data.get("channel", channel_id)

    return f"Message sent to <#{channel}>."


def _send_dm(event):
    user_id = event["user_id"]
    text = event["text"]

    # Open DM conversation
    open_data = _slack_request("conversations.open", body={"users": user_id})
    dm_channel = open_data["channel"]["id"]

    # Send the message
    _slack_request("chat.postMessage", body={"channel": dm_channel, "text": text})

    return f"Direct message sent to <@{user_id}>."


def _list_users(event):
    max_results = min(event.get("max_results", 20), 100)

    params = {"limit": str(max_results)}

    data = _slack_request("users.list", params=params)
    members = data.get("members", [])

    # Filter out bots and deleted users
    people = [
        m for m in members
        if not m.get("is_bot") and not m.get("deleted") and m.get("id") != "USLACKBOT"
    ]

    if not people:
        return "No users found."

    lines = []
    for u in people:
        name = u.get("real_name") or u.get("name", "unknown")
        user_id = u["id"]
        profile = u.get("profile", {})
        email = profile.get("email", "")
        display = profile.get("display_name", "")
        is_admin = u.get("is_admin", False)

        admin_tag = " [Admin]" if is_admin else ""
        display_tag = f" (@{display})" if display and display != name else ""
        email_line = f"\n  Email: {email}" if email else ""

        lines.append(f"**{name}**{display_tag}{admin_tag} ({user_id}){email_line}")

    return f"Found {len(lines)} user(s):\n\n" + "\n\n".join(lines)


# Tool routing table
TOOLS = {
    "slack_list_channels": _list_channels,
    "slack_read_messages": _read_messages,
    "slack_search": _search,
    "slack_send_message": _send_message,
    "slack_send_dm": _send_dm,
    "slack_list_users": _list_users,
}


def handler(event, context):
    """Slack connector Lambda handler for AgentCore Gateway."""
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
        return {"error": f"Slack connector error: {str(e)}"}
