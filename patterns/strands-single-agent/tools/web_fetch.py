"""Web fetch tool — fetches public web pages and returns clean text content.

Guardrails:
- SSRF protection: blocks private/internal IPs and localhost
- Content size limit: truncates to prevent context window overflow
- HTML stripping: returns clean text to reduce prompt injection surface
- Timeout: prevents slow sites from blocking the agent
- Identifies as a bot via User-Agent header
"""

import ipaddress
import socket
import urllib.parse
from typing import Optional

import requests
from strands import tool

# Limits
MAX_RESPONSE_BYTES = 100_000  # 100KB raw download limit
MAX_TEXT_CHARS = 30_000  # ~7.5K tokens — keeps context manageable
REQUEST_TIMEOUT = 15  # seconds
USER_AGENT = "AgentCore-WebFetch/1.0 (AI Assistant; +https://agentcore.com.au)"

# Blocked URL schemes
ALLOWED_SCHEMES = {"http", "https"}

# Blocked hostnames (case-insensitive)
BLOCKED_HOSTS = {
    "localhost",
    "metadata.google.internal",
    "169.254.169.254",  # AWS instance metadata
}


def _is_private_ip(hostname: str) -> bool:
    """Check if a hostname resolves to a private/reserved IP address."""
    try:
        # Resolve hostname to IP
        ip_str = socket.gethostbyname(hostname)
        ip = ipaddress.ip_address(ip_str)
        return (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
        )
    except (socket.gaierror, ValueError):
        # If we can't resolve it, block it to be safe
        return True


def _validate_url(url: str) -> str:
    """Validate and normalise a URL. Returns the cleaned URL or raises ValueError."""
    url = url.strip()
    if not url:
        raise ValueError("URL is required")

    # Add https:// if no scheme provided
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    parsed = urllib.parse.urlparse(url)

    if parsed.scheme not in ALLOWED_SCHEMES:
        raise ValueError(f"Scheme '{parsed.scheme}' not allowed. Use http or https.")

    hostname = parsed.hostname
    if not hostname:
        raise ValueError("Invalid URL: no hostname")

    if hostname.lower() in BLOCKED_HOSTS:
        raise ValueError(f"Access to '{hostname}' is blocked")

    if _is_private_ip(hostname):
        raise ValueError(f"Access to private/internal addresses is blocked")

    return url


def _html_to_text(html: str) -> str:
    """Strip HTML tags and extract readable text. Lightweight, no dependencies."""
    import re

    # Remove script and style blocks entirely
    text = re.sub(r"<script[^>]*>[\s\S]*?</script>", "", html, flags=re.IGNORECASE)
    text = re.sub(r"<style[^>]*>[\s\S]*?</style>", "", text, flags=re.IGNORECASE)
    # Remove HTML comments
    text = re.sub(r"<!--[\s\S]*?-->", "", text)
    # Replace block elements with newlines
    text = re.sub(r"<(?:br|p|div|h[1-6]|li|tr)[^>]*>", "\n", text, flags=re.IGNORECASE)
    # Remove remaining tags
    text = re.sub(r"<[^>]+>", "", text)
    # Decode common HTML entities
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    text = text.replace("&quot;", '"').replace("&#39;", "'").replace("&nbsp;", " ")
    # Collapse whitespace
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


@tool
def web_fetch(url: str, extract_text: Optional[bool] = True) -> str:
    """Fetch a public web page and return its content as clean text.

    Use this tool to look up information on public websites — company pages,
    news articles, government registries, regulatory guidance, market data, etc.

    Args:
        url: The URL to fetch (must be http or https, public internet only)
        extract_text: If True (default), strip HTML and return clean text. If False, return raw HTML.

    Returns:
        The page content as text, truncated to ~30,000 characters if longer.
    """
    try:
        validated_url = _validate_url(url)
    except ValueError as e:
        return f"Error: {e}"

    try:
        response = requests.get(
            validated_url,
            timeout=REQUEST_TIMEOUT,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
            },
            allow_redirects=True,
            stream=True,
        )
        response.raise_for_status()

        # Read with size limit
        content = response.content[:MAX_RESPONSE_BYTES].decode(
            response.encoding or "utf-8", errors="replace"
        )

        # Strip HTML to clean text if requested
        if extract_text and "html" in response.headers.get("content-type", "").lower():
            content = _html_to_text(content)

        # Truncate if still too long
        if len(content) > MAX_TEXT_CHARS:
            content = content[:MAX_TEXT_CHARS] + "\n\n[Content truncated at 30,000 characters]"

        return f"[Fetched: {validated_url}]\n\n{content}"

    except requests.Timeout:
        return f"Error: Request timed out after {REQUEST_TIMEOUT} seconds"
    except requests.ConnectionError:
        return f"Error: Could not connect to {validated_url}"
    except requests.HTTPError as e:
        return f"Error: HTTP {e.response.status_code} — {e.response.reason}"
    except Exception as e:
        return f"Error fetching URL: {e}"
