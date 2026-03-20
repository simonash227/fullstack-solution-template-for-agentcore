"""One-time Xero OAuth setup script.

Run this locally to authorize Xero access and store the refresh token
in AWS Secrets Manager. You'll need your Xero OAuth app credentials.

Prerequisites:
  1. Create a Xero app at https://developer.xero.com/app/manage
  2. Set app type to "Web app"
  3. Add redirect URI: http://localhost:8091
  4. Copy the Client ID and generate a Client Secret

Usage:
    python scripts/xero-oauth-setup.py --client-id YOUR_CLIENT_ID --stack-name fast-stack
"""

import argparse
import http.server
import json
import os
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser

REDIRECT_URI = "http://localhost:8091"
SCOPES = (
    "openid profile offline_access "
    "accounting.invoices.read "
    "accounting.payments.read "
    "accounting.banktransactions.read "
    "accounting.contacts.read "
    "accounting.settings.read "
    "accounting.reports.executivesummary.read "
    "accounting.reports.profitandloss.read "
    "accounting.reports.banksummary.read "
    "accounting.reports.balancesheet.read"
)
REGION = "ap-southeast-2"

auth_code = None


class OAuthHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        global auth_code
        query = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(query)

        if "code" in params:
            auth_code = params["code"][0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h2>Xero authorization successful!</h2><p>You can close this tab.</p>")
        else:
            self.send_response(400)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            error = params.get("error", ["unknown"])[0]
            self.wfile.write(f"<h2>Authorization failed: {error}</h2>".encode())

    def log_message(self, format, *args):
        pass


def get_tenant_id(access_token):
    """Fetch the Xero tenant ID from the connections endpoint."""
    req = urllib.request.Request("https://api.xero.com/connections", method="GET")
    req.add_header("Authorization", f"Bearer {access_token}")
    req.add_header("Content-Type", "application/json")

    with urllib.request.urlopen(req, timeout=10) as resp:
        connections = json.loads(resp.read())

    if not connections:
        print("Error: No Xero organisations connected. Authorise access to at least one organisation.")
        sys.exit(1)

    if len(connections) == 1:
        tenant = connections[0]
        print(f"  Organisation: {tenant['tenantName']}")
        print(f"  Tenant ID:    {tenant['tenantId']}")
        return tenant["tenantId"]

    # Multiple orgs — let user choose
    print("\nMultiple Xero organisations found:")
    for i, conn in enumerate(connections):
        print(f"  [{i + 1}] {conn['tenantName']} ({conn['tenantId']})")

    choice = input(f"\nSelect organisation (1-{len(connections)}): ").strip()
    idx = int(choice) - 1
    if idx < 0 or idx >= len(connections):
        print("Invalid selection.")
        sys.exit(1)

    tenant = connections[idx]
    print(f"  Selected: {tenant['tenantName']}")
    return tenant["tenantId"]


def main():
    parser = argparse.ArgumentParser(description="One-time Xero OAuth setup")
    parser.add_argument("--client-id", required=True, help="Xero OAuth Client ID")
    parser.add_argument("--stack-name", default="fast-stack", help="Stack name for secret path (default: fast-stack)")
    parser.add_argument("--region", default=REGION, help=f"AWS region (default: {REGION})")
    args = parser.parse_args()

    client_id = args.client_id
    secret_name = f"/agentcore/{args.stack_name}/xero/oauth"

    client_secret = input("Paste your Xero OAuth Client Secret: ").strip()
    if not client_secret:
        print("Error: Client secret is required.")
        sys.exit(1)

    # Start local server to receive callback
    server = http.server.HTTPServer(("localhost", 8091), OAuthHandler)
    thread = threading.Thread(target=server.handle_request)
    thread.start()

    # Open browser for authorization
    auth_url = (
        "https://login.xero.com/identity/connect/authorize?"
        + urllib.parse.urlencode({
            "client_id": client_id,
            "redirect_uri": REDIRECT_URI,
            "response_type": "code",
            "scope": SCOPES,
        })
    )

    print("\nOpening browser for Xero authorization...")
    print(f"If the browser doesn't open, go to:\n{auth_url}\n")
    webbrowser.open(auth_url)

    # Wait for callback
    thread.join(timeout=120)
    server.server_close()

    if not auth_code:
        print("Error: Did not receive authorization code. Timed out or user denied.")
        sys.exit(1)

    print("Authorization code received. Exchanging for tokens...")

    # Exchange code for tokens
    token_data = urllib.parse.urlencode({
        "code": auth_code,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code",
    }).encode()

    req = urllib.request.Request(
        "https://identity.xero.com/connect/token",
        data=token_data,
        method="POST",
    )
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    with urllib.request.urlopen(req) as resp:
        tokens = json.loads(resp.read())

    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        print("Error: No refresh token received.")
        sys.exit(1)

    access_token = tokens["access_token"]
    print("Tokens obtained successfully.\n")

    # Get tenant ID
    print("Fetching Xero organisation...")
    tenant_id = get_tenant_id(access_token)

    # Store in Secrets Manager
    secret_value = json.dumps({
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "tenant_id": tenant_id,
    })

    print(f"\nStoring credentials in Secrets Manager ({secret_name})...")

    env = {**os.environ, "AWS_PROFILE": "agentcore-dev"}

    try:
        subprocess.run(
            [
                "aws", "secretsmanager", "create-secret",
                "--name", secret_name,
                "--region", args.region,
                "--secret-string", secret_value,
            ],
            check=True,
            capture_output=True,
            env=env,
        )
        print("Secret created successfully.")
    except subprocess.CalledProcessError:
        subprocess.run(
            [
                "aws", "secretsmanager", "put-secret-value",
                "--secret-id", secret_name,
                "--region", args.region,
                "--secret-string", secret_value,
            ],
            check=True,
            capture_output=True,
            env=env,
        )
        print("Secret updated successfully.")

    print(f"\nDone! Xero connector is now authorized.")
    print(f"Secret stored at: {secret_name}")
    print(f"Tenant ID: {tenant_id}")
    print(f"\nNext steps:")
    print(f"  1. Add 'xero' to the client's integrations[] in client-config.json")
    print(f"  2. Run: cdk deploy (to create the Xero connector Lambda and Gateway Target)")


if __name__ == "__main__":
    main()
