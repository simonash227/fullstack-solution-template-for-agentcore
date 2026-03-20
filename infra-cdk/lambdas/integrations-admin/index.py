"""Integrations Admin API — OAuth connection management for client integrations."""

import hashlib
import hmac
import json
import os
import time
import urllib.parse
import urllib.request

import boto3
from aws_lambda_powertools import Logger
from aws_lambda_powertools.event_handler import (
    APIGatewayRestResolver,
    CORSConfig,
    Response,
)
from aws_lambda_powertools.event_handler.api_gateway import Router
from aws_lambda_powertools.logging.correlation_paths import API_GATEWAY_REST
from aws_lambda_powertools.utilities.typing import LambdaContext
from botocore.exceptions import ClientError

STACK_NAME = os.environ.get("STACK_NAME", "")
OAUTH_APPS_SECRET_ID = os.environ.get("OAUTH_APPS_SECRET_ID", "")
FRONTEND_URL = os.environ.get("FRONTEND_URL", "")
CORS_ALLOWED_ORIGINS = os.environ.get("CORS_ALLOWED_ORIGINS", "*")
STATE_MAX_AGE_SECONDS = 600  # 10 minutes

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

sm = boto3.client("secretsmanager")
logger = Logger()
app = APIGatewayRestResolver(cors=cors_config)

# ---------------------------------------------------------------------------
# Provider definitions — extensible dictionary
# ---------------------------------------------------------------------------
PROVIDERS = {
    "gmail": {
        "name": "Gmail",
        "type": "oauth",
        "auth_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "scopes": (
            "https://www.googleapis.com/auth/gmail.readonly "
            "https://www.googleapis.com/auth/gmail.send "
            "https://www.googleapis.com/auth/gmail.modify"
        ),
        "extra_auth_params": {"access_type": "offline", "prompt": "consent"},
        "secret_suffix": "gmail/oauth",
        "validate_url": "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        "account_field": "emailAddress",
    },
    "xero": {
        "name": "Xero Accounting",
        "type": "oauth",
        "auth_url": "https://login.xero.com/identity/connect/authorize",
        "token_url": "https://identity.xero.com/connect/token",
        "scopes": (
            "openid profile offline_access "
            "accounting.transactions.read accounting.contacts.read "
            "accounting.settings.read accounting.reports.read "
            "accounting.journals.read accounting.budgets.read "
            "accounting.attachments.read "
            "accounting.reports.bankstatement.read "
            "accounting.reports.tenninetynine.read"
        ),
        "extra_auth_params": {},
        "secret_suffix": "xero/oauth",
        "connections_url": "https://api.xero.com/connections",
        "account_field": "tenantName",
    },
    "slack": {
        "name": "Slack",
        "type": "oauth",
        "auth_url": "https://slack.com/oauth/v2/authorize",
        "token_url": "https://slack.com/api/oauth.v2.access",
        "scopes": (
            "channels:read,channels:history,groups:read,groups:history,"
            "im:read,im:write,im:history,chat:write,users:read,users:read.email"
        ),
        "user_scopes": "search:read",
        "extra_auth_params": {},
        "secret_suffix": "slack/oauth",
        "validate_url": "https://slack.com/api/auth.test",
        "account_field": "team",
    },
    "microsoft365": {
        "name": "Microsoft 365",
        "type": "admin",
        "secret_suffix": "microsoft365/oauth",
    },
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_oauth_apps() -> dict | None:
    """Read Simon's OAuth app credentials from Secrets Manager."""
    try:
        resp = sm.get_secret_value(SecretId=OAUTH_APPS_SECRET_ID)
        return json.loads(resp["SecretString"])
    except ClientError as e:
        if e.response["Error"]["Code"] == "ResourceNotFoundException":
            return None
        logger.exception("Failed to read oauth-apps secret")
        raise


def _get_provider_secret(provider: str) -> dict | None:
    """Read a provider's stored credentials."""
    suffix = PROVIDERS[provider]["secret_suffix"]
    secret_id = f"/agentcore/{STACK_NAME}/{suffix}"
    try:
        resp = sm.get_secret_value(SecretId=secret_id)
        return json.loads(resp["SecretString"])
    except ClientError as e:
        if e.response["Error"]["Code"] in ("ResourceNotFoundException", "AccessDeniedException"):
            return None
        logger.exception(f"Failed to read {provider} secret")
        raise


def _store_provider_secret(provider: str, secret_data: dict) -> None:
    """Create or update a provider's credentials."""
    suffix = PROVIDERS[provider]["secret_suffix"]
    secret_id = f"/agentcore/{STACK_NAME}/{suffix}"
    secret_string = json.dumps(secret_data)
    try:
        sm.create_secret(
            Name=secret_id,
            SecretString=secret_string,
            Description=f"OAuth credentials for {PROVIDERS[provider]['name']}",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ResourceExistsException":
            sm.put_secret_value(SecretId=secret_id, SecretString=secret_string)
        else:
            raise


def _delete_provider_secret(provider: str) -> None:
    """Delete a provider's credentials."""
    suffix = PROVIDERS[provider]["secret_suffix"]
    secret_id = f"/agentcore/{STACK_NAME}/{suffix}"
    try:
        sm.delete_secret(SecretId=secret_id, ForceDeleteWithoutRecovery=True)
    except ClientError as e:
        if e.response["Error"]["Code"] == "ResourceNotFoundException":
            pass  # Already gone
        else:
            raise


def _build_callback_url(event: dict, provider: str) -> str:
    """Construct the OAuth callback URL from the current request context."""
    domain = event.get("requestContext", {}).get("domainName", "")
    stage = event.get("requestContext", {}).get("stage", "prod")
    return f"https://{domain}/{stage}/integrations/{provider}/callback"


def _sign_state(payload: dict, signing_key: str) -> str:
    """Create an HMAC-signed state parameter."""
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    payload_b64 = urllib.parse.quote(payload_json)
    signature = hmac.new(
        signing_key.encode(), payload_b64.encode(), hashlib.sha256
    ).hexdigest()
    return f"{payload_b64}.{signature}"


def _verify_state(state: str, signing_key: str) -> dict | None:
    """Verify and decode an HMAC-signed state parameter."""
    if "." not in state:
        return None
    payload_b64, signature = state.rsplit(".", 1)
    expected = hmac.new(
        signing_key.encode(), payload_b64.encode(), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        payload = json.loads(urllib.parse.unquote(payload_b64))
    except (json.JSONDecodeError, ValueError):
        return None
    # Check timestamp
    if time.time() - payload.get("ts", 0) > STATE_MAX_AGE_SECONDS:
        return None
    return payload


def _validate_connection(provider: str, creds: dict) -> dict | None:
    """Make a lightweight API call to validate stored credentials. Returns account info."""
    try:
        if provider == "gmail":
            token = _refresh_gmail_token(creds)
            if not token:
                return None
            req = urllib.request.Request(PROVIDERS["gmail"]["validate_url"])
            req.add_header("Authorization", f"Bearer {token}")
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read())
            return {"account": data.get("emailAddress", "connected")}

        elif provider == "xero":
            token = _refresh_xero_token(creds)
            if not token:
                return None
            req = urllib.request.Request(PROVIDERS["xero"]["connections_url"])
            req.add_header("Authorization", f"Bearer {token}")
            req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, timeout=10) as resp:
                connections = json.loads(resp.read())
            if connections:
                return {"account": connections[0].get("tenantName", "connected")}
            return {"account": "connected"}

        elif provider == "slack":
            bot_token = creds.get("bot_token", "")
            req = urllib.request.Request(
                f"{PROVIDERS['slack']['validate_url']}?token={bot_token}"
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read())
            if data.get("ok"):
                return {"account": data.get("team", "connected")}
            return None

        elif provider == "microsoft365":
            # M365 uses client credentials — validate by attempting token fetch
            token = _get_m365_token(creds)
            return {"account": f"Tenant: {creds.get('tenant_id', 'configured')[:8]}..."} if token else None

    except Exception:
        logger.exception(f"Validation failed for {provider}")
        return None


def _refresh_gmail_token(creds: dict) -> str | None:
    """Get a fresh Gmail access token using refresh token."""
    data = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "client_id": creds["client_id"],
        "client_secret": creds["client_secret"],
        "refresh_token": creds["refresh_token"],
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read()).get("access_token")
    except Exception:
        return None


def _refresh_xero_token(creds: dict) -> str | None:
    """Get a fresh Xero access token. Note: Xero rotates refresh tokens."""
    data = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "client_id": creds["client_id"],
        "client_secret": creds["client_secret"],
        "refresh_token": creds["refresh_token"],
    }).encode()
    req = urllib.request.Request("https://identity.xero.com/connect/token", data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            token_data = json.loads(resp.read())
        # Xero rotates refresh tokens — update stored credentials
        new_refresh = token_data.get("refresh_token")
        if new_refresh and new_refresh != creds["refresh_token"]:
            creds["refresh_token"] = new_refresh
            _store_provider_secret("xero", creds)
        return token_data.get("access_token")
    except Exception:
        return None


def _get_m365_token(creds: dict) -> str | None:
    """Get M365 access token via client credentials flow."""
    tenant_id = creds.get("tenant_id", "")
    data = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": creds["client_id"],
        "client_secret": creds["client_secret"],
        "scope": "https://graph.microsoft.com/.default",
    }).encode()
    req = urllib.request.Request(
        f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token",
        data=data, method="POST",
    )
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read()).get("access_token")
    except Exception:
        return None


def _success_html(provider: str, account: str = "") -> str:
    """HTML page returned after successful OAuth callback."""
    name = PROVIDERS.get(provider, {}).get("name", provider)
    return f"""<!DOCTYPE html>
<html><head><title>Connected</title>
<style>body{{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f8f9fa}}
.card{{background:white;border-radius:12px;padding:40px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.1)}}
h2{{color:#16a34a;margin:0 0 8px}}p{{color:#6b7280;margin:0}}</style></head>
<body><div class="card">
<h2>{name} connected</h2>
<p>{account or 'You can close this window.'}</p>
</div>
<script>
if(window.opener){{window.opener.postMessage({{type:'oauth-complete',provider:'{provider}',success:true}},'{FRONTEND_URL}')}}
setTimeout(()=>window.close(),2000)
</script></body></html>"""


def _error_html(provider: str, error: str = "Connection failed") -> str:
    """HTML page returned after failed OAuth callback."""
    name = PROVIDERS.get(provider, {}).get("name", provider)
    return f"""<!DOCTYPE html>
<html><head><title>Error</title>
<style>body{{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f8f9fa}}
.card{{background:white;border-radius:12px;padding:40px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.1)}}
h2{{color:#dc2626;margin:0 0 8px}}p{{color:#6b7280;margin:0}}</style></head>
<body><div class="card">
<h2>{name} — {error}</h2>
<p>Please close this window and try again.</p>
</div>
<script>
if(window.opener){{window.opener.postMessage({{type:'oauth-complete',provider:'{provider}',success:false,error:'{error}'}},'{FRONTEND_URL}')}}
</script></body></html>"""


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/integrations")
def list_integrations():
    """List all available integrations with their connection status."""
    oauth_apps = _get_oauth_apps()
    if not oauth_apps:
        return {
            "configured": False,
            "integrations": [
                {"provider": p, "name": info["name"], "type": info["type"], "status": "not_configured"}
                for p, info in PROVIDERS.items()
            ],
        }

    results = []
    for provider, info in PROVIDERS.items():
        entry = {
            "provider": provider,
            "name": info["name"],
            "type": info["type"],
            "status": "not_connected",
        }

        creds = _get_provider_secret(provider)
        if creds:
            validation = _validate_connection(provider, creds)
            if validation:
                entry["status"] = "connected"
                entry["account"] = validation.get("account", "")
            else:
                entry["status"] = "expired"

        results.append(entry)

    return {"configured": True, "integrations": results}


@app.get("/integrations/<provider>/auth-url")
def get_auth_url(provider: str):
    """Generate an OAuth authorization URL for the given provider."""
    if provider not in PROVIDERS or PROVIDERS[provider]["type"] != "oauth":
        return {"error": f"Invalid provider: {provider}"}, 400

    oauth_apps = _get_oauth_apps()
    if not oauth_apps or provider not in oauth_apps:
        return {"error": f"{provider} not configured. Run setup-oauth-apps.py first."}, 400

    app_creds = oauth_apps[provider]
    signing_key = oauth_apps.get("signing_key", "")
    provider_config = PROVIDERS[provider]

    callback_url = _build_callback_url(app.current_event.raw_event, provider)

    state = _sign_state(
        {"provider": provider, "ts": int(time.time())},
        signing_key,
    )

    params = {
        "client_id": app_creds["client_id"],
        "redirect_uri": callback_url,
        "response_type": "code",
        "state": state,
    }

    # Gmail/Xero use space-separated scopes, Slack uses comma-separated + user_scope
    if provider == "slack":
        params["scope"] = provider_config["scopes"]
        if "user_scopes" in provider_config:
            params["user_scope"] = provider_config["user_scopes"]
    else:
        params["scope"] = provider_config["scopes"]

    params.update(provider_config.get("extra_auth_params", {}))

    auth_url = f"{provider_config['auth_url']}?{urllib.parse.urlencode(params)}"
    return {"url": auth_url}


@app.get("/integrations/<provider>/callback")
def oauth_callback(provider: str):
    """Handle OAuth redirect from provider. Returns HTML with postMessage."""
    if provider not in PROVIDERS or PROVIDERS[provider]["type"] != "oauth":
        return Response(
            status_code=400,
            content_type="text/html",
            body=_error_html(provider, "Invalid provider"),
        )

    params = app.current_event.query_string_parameters or {}

    # Check for OAuth error
    if "error" in params:
        error_desc = params.get("error_description", params["error"])
        logger.warning(f"OAuth error for {provider}: {error_desc}")
        return Response(
            status_code=200,
            content_type="text/html",
            body=_error_html(provider, error_desc),
        )

    code = params.get("code")
    state = params.get("state", "")
    if not code:
        return Response(
            status_code=400,
            content_type="text/html",
            body=_error_html(provider, "Missing authorization code"),
        )

    # Verify state
    oauth_apps = _get_oauth_apps()
    if not oauth_apps:
        return Response(
            status_code=500,
            content_type="text/html",
            body=_error_html(provider, "OAuth apps not configured"),
        )

    signing_key = oauth_apps.get("signing_key", "")
    state_data = _verify_state(state, signing_key)
    if not state_data or state_data.get("provider") != provider:
        return Response(
            status_code=400,
            content_type="text/html",
            body=_error_html(provider, "Invalid or expired state"),
        )

    # Exchange code for tokens
    app_creds = oauth_apps.get(provider, {})
    callback_url = _build_callback_url(app.current_event.raw_event, provider)
    provider_config = PROVIDERS[provider]

    try:
        if provider == "slack":
            token_data = _exchange_slack_code(code, app_creds, callback_url)
        else:
            token_data = _exchange_code(code, app_creds, callback_url, provider_config["token_url"])
    except Exception as e:
        logger.exception(f"Token exchange failed for {provider}")
        return Response(
            status_code=200,
            content_type="text/html",
            body=_error_html(provider, "Token exchange failed"),
        )

    # Build secret data and store
    try:
        secret_data = _build_secret_data(provider, app_creds, token_data)
        _store_provider_secret(provider, secret_data)
    except Exception as e:
        logger.exception(f"Failed to store credentials for {provider}")
        return Response(
            status_code=200,
            content_type="text/html",
            body=_error_html(provider, "Failed to store credentials"),
        )

    account = secret_data.get("_account_display", "")
    return Response(
        status_code=200,
        content_type="text/html",
        body=_success_html(provider, account),
    )


@app.delete("/integrations/<provider>")
def disconnect(provider: str):
    """Remove stored credentials for a provider."""
    if provider not in PROVIDERS:
        return {"error": f"Invalid provider: {provider}"}, 400

    _delete_provider_secret(provider)
    return {"status": "disconnected", "provider": provider}


# ---------------------------------------------------------------------------
# Token exchange helpers
# ---------------------------------------------------------------------------

def _exchange_code(code: str, app_creds: dict, callback_url: str, token_url: str) -> dict:
    """Standard OAuth2 authorization code exchange."""
    data = urllib.parse.urlencode({
        "grant_type": "authorization_code",
        "code": code,
        "client_id": app_creds["client_id"],
        "client_secret": app_creds["client_secret"],
        "redirect_uri": callback_url,
    }).encode()
    req = urllib.request.Request(token_url, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def _exchange_slack_code(code: str, app_creds: dict, callback_url: str) -> dict:
    """Slack uses a slightly different token exchange format."""
    data = urllib.parse.urlencode({
        "code": code,
        "client_id": app_creds["client_id"],
        "client_secret": app_creds["client_secret"],
        "redirect_uri": callback_url,
    }).encode()
    req = urllib.request.Request(PROVIDERS["slack"]["token_url"], data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def _build_secret_data(provider: str, app_creds: dict, token_data: dict) -> dict:
    """Build the secret payload from token exchange response."""
    if provider == "gmail":
        return {
            "client_id": app_creds["client_id"],
            "client_secret": app_creds["client_secret"],
            "refresh_token": token_data["refresh_token"],
            "_account_display": token_data.get("id_token", ""),
        }

    elif provider == "xero":
        # Get tenant_id from connections API
        tenant_id = ""
        account_name = ""
        access_token = token_data.get("access_token", "")
        if access_token:
            try:
                req = urllib.request.Request(PROVIDERS["xero"]["connections_url"])
                req.add_header("Authorization", f"Bearer {access_token}")
                req.add_header("Content-Type", "application/json")
                with urllib.request.urlopen(req, timeout=10) as resp:
                    connections = json.loads(resp.read())
                if connections:
                    tenant_id = connections[0].get("tenantId", "")
                    account_name = connections[0].get("tenantName", "")
            except Exception:
                logger.warning("Failed to fetch Xero connections for tenant_id")
        return {
            "client_id": app_creds["client_id"],
            "client_secret": app_creds["client_secret"],
            "refresh_token": token_data["refresh_token"],
            "tenant_id": tenant_id,
            "_account_display": account_name,
        }

    elif provider == "slack":
        return {
            "bot_token": token_data.get("access_token", ""),
            "user_token": token_data.get("authed_user", {}).get("access_token", ""),
            "team_id": token_data.get("team", {}).get("id", ""),
            "team_name": token_data.get("team", {}).get("name", ""),
            "client_id": app_creds["client_id"],
            "client_secret": app_creds["client_secret"],
            "_account_display": token_data.get("team", {}).get("name", ""),
        }

    return token_data


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------

@logger.inject_lambda_context(correlation_id_path=API_GATEWAY_REST)
def handler(event, context: LambdaContext):
    return app.resolve(event, context)
