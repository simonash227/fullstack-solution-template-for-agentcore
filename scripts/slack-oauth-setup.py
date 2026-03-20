"""One-time Slack OAuth setup script.

Run this locally to install the Slack app into a workspace and store
the bot token + user token in AWS Secrets Manager.

Prerequisites:
  1. Create a Slack app at https://api.slack.com/apps
  2. Under OAuth & Permissions, add Bot Token Scopes:
     channels:read, channels:history, groups:read, groups:history,
     im:read, im:write, im:history, chat:write, users:read, users:read.email
  3. Under User Token Scopes, add: search:read
  4. Set redirect URL: http://localhost:8092
  5. Copy the Client ID and Client Secret from Basic Information

Usage:
    python scripts/slack-oauth-setup.py --client-id YOUR_CLIENT_ID --stack-name fast-stack
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

REDIRECT_URI = "http://localhost:8092"
BOT_SCOPES = "channels:read,channels:history,groups:read,groups:history,im:read,im:write,im:history,chat:write,users:read,users:read.email"
USER_SCOPES = "search:read"
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
            self.wfile.write(b"<h2>Slack authorization successful!</h2><p>You can close this tab.</p>")
        else:
            self.send_response(400)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            error = params.get("error", ["unknown"])[0]
            self.wfile.write(f"<h2>Authorization failed: {error}</h2>".encode())

    def log_message(self, format, *args):
        pass


def main():
    parser = argparse.ArgumentParser(description="One-time Slack OAuth setup")
    parser.add_argument("--client-id", required=True, help="Slack App Client ID")
    parser.add_argument("--stack-name", default="fast-stack", help="Stack name for secret path")
    parser.add_argument("--region", default=REGION, help=f"AWS region (default: {REGION})")
    args = parser.parse_args()

    client_id = args.client_id
    secret_name = f"/agentcore/{args.stack_name}/slack/oauth"

    client_secret = input("Paste your Slack App Client Secret: ").strip()
    if not client_secret:
        print("Error: Client secret is required.")
        sys.exit(1)

    # Start local server to receive callback
    server = http.server.HTTPServer(("localhost", 8092), OAuthHandler)
    thread = threading.Thread(target=server.handle_request)
    thread.start()

    # Open browser for authorization
    auth_url = (
        "https://slack.com/oauth/v2/authorize?"
        + urllib.parse.urlencode({
            "client_id": client_id,
            "scope": BOT_SCOPES,
            "user_scope": USER_SCOPES,
            "redirect_uri": REDIRECT_URI,
        })
    )

    print("\nOpening browser for Slack authorization...")
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
        "client_id": client_id,
        "client_secret": client_secret,
        "code": auth_code,
        "redirect_uri": REDIRECT_URI,
    }).encode()

    req = urllib.request.Request(
        "https://slack.com/api/oauth.v2.access",
        data=token_data,
        method="POST",
    )
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    with urllib.request.urlopen(req) as resp:
        tokens = json.loads(resp.read())

    if not tokens.get("ok"):
        print(f"Error: Slack token exchange failed: {tokens.get('error', 'unknown')}")
        sys.exit(1)

    bot_token = tokens.get("access_token")
    user_token = tokens.get("authed_user", {}).get("access_token")
    team_id = tokens.get("team", {}).get("id", "")
    team_name = tokens.get("team", {}).get("name", "")

    if not bot_token:
        print("Error: No bot token received.")
        sys.exit(1)

    print(f"Bot token obtained: {bot_token[:15]}...")
    if user_token:
        print(f"User token obtained: {user_token[:15]}... (for search)")
    else:
        print("Warning: No user token received. search.messages will not work.")
        print("Make sure 'search:read' is in User Token Scopes.")

    print(f"Workspace: {team_name} ({team_id})")

    # Store in Secrets Manager
    secret_value = json.dumps({
        "bot_token": bot_token,
        "user_token": user_token or "",
        "team_id": team_id,
        "team_name": team_name,
        "client_id": client_id,
        "client_secret": client_secret,
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

    print(f"\nDone! Slack connector is now authorized.")
    print(f"Secret stored at: {secret_name}")
    print(f"Workspace: {team_name} ({team_id})")
    print(f"\nNext steps:")
    print(f"  1. Add 'slack' to the client's integrations[] in client-config.json")
    print(f"  2. Run: cdk deploy")
    print(f"  3. Invite the bot to channels: /invite @YourBotName in each channel")


if __name__ == "__main__":
    main()
