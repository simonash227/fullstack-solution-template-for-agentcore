"""One-time Gmail OAuth setup script.

Run this locally to authorize Gmail access and store the refresh token
in AWS Secrets Manager. You'll need to paste your Google OAuth client secret
when prompted.

Usage:
    python scripts/gmail-oauth-setup.py
"""

import json
import http.server
import urllib.parse
import urllib.request
import webbrowser
import threading
import sys
import subprocess

CLIENT_ID = "856615144040-9rs41acm3beqqjpejv6ts0r20u25sqiq.apps.googleusercontent.com"
REDIRECT_URI = "http://localhost:8090"
SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify"
SECRET_NAME = "/agentcore/fast-stack/gmail/oauth"
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
            self.wfile.write(b"<h2>Authorization successful!</h2><p>You can close this tab.</p>")
        else:
            self.send_response(400)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            error = params.get("error", ["unknown"])[0]
            self.wfile.write(f"<h2>Authorization failed: {error}</h2>".encode())

    def log_message(self, format, *args):
        pass  # Suppress request logging


def main():
    client_secret = input("Paste your Google OAuth Client Secret: ").strip()
    if not client_secret:
        print("Error: Client secret is required.")
        sys.exit(1)

    # Start local server to receive callback
    server = http.server.HTTPServer(("localhost", 8090), OAuthHandler)
    thread = threading.Thread(target=server.handle_request)
    thread.start()

    # Open browser for authorization
    auth_url = (
        "https://accounts.google.com/o/oauth2/v2/auth?"
        + urllib.parse.urlencode({
            "client_id": CLIENT_ID,
            "redirect_uri": REDIRECT_URI,
            "response_type": "code",
            "scope": SCOPES,
            "access_type": "offline",
            "prompt": "consent",
        })
    )

    print("\nOpening browser for Google authorization...")
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
        "client_id": CLIENT_ID,
        "client_secret": client_secret,
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code",
    }).encode()

    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=token_data,
        method="POST",
    )
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    with urllib.request.urlopen(req) as resp:
        tokens = json.loads(resp.read())

    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        print("Error: No refresh token received. Make sure prompt=consent was used.")
        sys.exit(1)

    print(f"Refresh token obtained successfully.")

    # Store in Secrets Manager
    secret_value = json.dumps({
        "client_id": CLIENT_ID,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
    })

    print(f"\nStoring credentials in Secrets Manager ({SECRET_NAME})...")

    # Use AWS CLI to create/update secret
    try:
        subprocess.run(
            [
                "aws", "secretsmanager", "create-secret",
                "--name", SECRET_NAME,
                "--region", REGION,
                "--secret-string", secret_value,
            ],
            check=True,
            capture_output=True,
            env={**__import__("os").environ, "AWS_PROFILE": "agentcore-dev"},
        )
        print("Secret created successfully.")
    except subprocess.CalledProcessError:
        # Secret may already exist — update it
        subprocess.run(
            [
                "aws", "secretsmanager", "put-secret-value",
                "--secret-id", SECRET_NAME,
                "--region", REGION,
                "--secret-string", secret_value,
            ],
            check=True,
            capture_output=True,
            env={**__import__("os").environ, "AWS_PROFILE": "agentcore-dev"},
        )
        print("Secret updated successfully.")

    print("\nDone! Gmail connector is now authorized.")
    print(f"Secret stored at: {SECRET_NAME}")


if __name__ == "__main__":
    main()
