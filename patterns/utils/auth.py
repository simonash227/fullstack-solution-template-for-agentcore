"""
Authentication utilities for agent patterns.

Provides secure user identity extraction from JWT tokens in the AgentCore Runtime
RequestContext (prevents impersonation via prompt injection).
"""

import logging

import jwt
from bedrock_agentcore.runtime import RequestContext

logger = logging.getLogger(__name__)

def extract_user_id_from_context(context: RequestContext) -> str:
    """
    Securely extract the user ID from the JWT token in the request context.

    AgentCore Runtime validates the JWT token before passing it to the agent,
    so we can safely skip signature verification here. The user ID is taken
    from the token's 'sub' claim rather than from the request payload, which
    prevents impersonation via prompt injection.

    Args:
        context (RequestContext): The request context provided by AgentCore
            Runtime, containing validated request headers including the
            Authorization JWT.

    Returns:
        str: The user ID (sub claim) extracted from the validated JWT token.

    Raises:
        ValueError: If the Authorization header is missing or the JWT does
            not contain a 'sub' claim.
    """
    request_headers = context.request_headers
    if not request_headers:
        raise ValueError(
            "No request headers found in context. "
            "Ensure the AgentCore Runtime is configured with a request header allowlist "
            "that includes the Authorization header."
        )

    auth_header = request_headers.get("Authorization")
    if not auth_header:
        raise ValueError(
            "No Authorization header found in request context. "
            "Ensure the AgentCore Runtime is configured with JWT inbound auth "
            "and the Authorization header is in the request header allowlist."
        )

    # Remove "Bearer " prefix to get the raw JWT token
    token = (
        auth_header.replace("Bearer ", "")
        if auth_header.startswith("Bearer ")
        else auth_header
    )

    # Decode without signature verification — AgentCore Runtime already validated the token.
    # We use options to skip all verification since this is a trusted, pre-validated token.
    claims = jwt.decode(
        jwt=token,
        options={"verify_signature": False},
        algorithms=["RS256"],
    )

    user_id = claims.get("sub")
    if not user_id:
        raise ValueError(
            "JWT token does not contain a 'sub' claim. "
            "Cannot determine user identity."
        )

    logger.info("Extracted user_id from JWT: %s", user_id)
    return user_id
