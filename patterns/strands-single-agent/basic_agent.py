import json
import os
import time
import traceback

import boto3
from bedrock_agentcore.identity.auth import requires_access_token
from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig, RetrievalConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import (
    AgentCoreMemorySessionManager,
)
from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from mcp.client.streamable_http import streamablehttp_client
from strands import Agent
from strands.models import BedrockModel
from strands.tools.mcp import MCPClient
from strands_code_interpreter import StrandsCodeInterpreterTools

from tools.web_fetch import web_fetch
from tools.request_approval import request_approval
from utils.audit import log_tool_call
from utils.auth import extract_user_id_from_context
from utils.ssm import get_ssm_parameter

app = BedrockAgentCoreApp()

# System prompt cache: assembled from workspace S3 files with 5-minute TTL
_prompt_cache: dict = {"text": None, "loaded_at": 0.0}
PROMPT_CACHE_TTL_SECONDS = 300  # 5 minutes

WORKSPACE_BUCKET = os.environ.get("WORKSPACE_BUCKET", "")
WORKSPACE_PREFIX = os.environ.get("WORKSPACE_PREFIX", "agent-workspace/")


def get_system_prompt() -> str:
    """
    Assemble the system prompt from workspace files in S3 with a 5-minute TTL cache.

    Reads base-persona.md and map.md from the agent-workspace/ prefix, concatenates
    them, and caches the result. Placeholder tokens ({{AGENT_NAME}}, {{FIRM_NAME}}, etc.)
    are rendered at deploy time by assemble-workspace.py — not at runtime.

    Returns:
        str: The assembled system prompt text.

    Raises:
        ValueError: If workspace files cannot be loaded from S3.
    """
    now = time.time()
    if _prompt_cache["text"] is not None and (now - _prompt_cache["loaded_at"]) < PROMPT_CACHE_TTL_SECONDS:
        return _prompt_cache["text"]

    s3 = boto3.client("s3", region_name=os.environ.get("AWS_DEFAULT_REGION", "ap-southeast-2"))
    parts = []
    for key in ["base-persona.md", "map.md"]:
        full_key = f"{WORKSPACE_PREFIX}{key}"
        print(f"[PROMPT] Loading s3://{WORKSPACE_BUCKET}/{full_key}")
        response = s3.get_object(Bucket=WORKSPACE_BUCKET, Key=full_key)
        parts.append(response["Body"].read().decode("utf-8"))

    text = "\n\n".join(parts)

    if not text.strip():
        raise ValueError("Assembled system prompt is empty")

    _prompt_cache["text"] = text
    _prompt_cache["loaded_at"] = now
    print(f"[PROMPT] Assembled {len(text)} chars from workspace, cached for {PROMPT_CACHE_TTL_SECONDS}s")
    return text

# OAuth2 Credential Provider decorator from AgentCore Identity SDK.
# Automatically retrieves OAuth2 access tokens from the Token Vault (with caching)
# or fetches fresh tokens from the configured OAuth2 provider when expired.
# The provider_name references an OAuth2 Credential Provider registered in AgentCore Identity.
@requires_access_token(
    provider_name=os.environ["GATEWAY_CREDENTIAL_PROVIDER_NAME"],
    auth_flow="M2M",
    scopes=[]
)
def _fetch_gateway_token(access_token: str) -> str:
    """
    Fetch fresh OAuth2 token for AgentCore Gateway authentication.
    
    The @requires_access_token decorator handles token retrieval and refresh:
    1. Token Retrieval: Calls GetResourceOauth2Token API to fetch token from Token Vault
    2. Automatic Refresh: Uses refresh tokens to renew expired access tokens
    3. Error Orchestration: Handles missing tokens and OAuth flow management
    
    For M2M (Machine-to-Machine) flows, the decorator uses Client Credentials grant type.
    The provider_name must match the Name field in the CDK OAuth2CredentialProvider resource.

    This MUST be synchronous because it's called inside the MCPClient lambda factory.
    If it were async, the lambda would receive a coroutine object instead of a string,
    breaking authentication.
    """
    return access_token


def create_gateway_mcp_client() -> MCPClient:
    """
    Create MCP client for AgentCore Gateway with OAuth2 authentication.

    MCP (Model Context Protocol) is how agents communicate with tool providers.
    This creates a client that can talk to the AgentCore Gateway using OAuth2
    authentication. The Gateway then provides access to Lambda-based tools.
    
    This implementation avoids the "closure trap" by calling _fetch_gateway_token()
    inside the lambda factory. This ensures a fresh token is fetched on every MCP reconnection,
    preventing stale token errors.
    """
    stack_name = os.environ.get("STACK_NAME")
    if not stack_name:
        raise ValueError("STACK_NAME environment variable is required")

    # Validate stack name format to prevent injection
    if not stack_name.replace("-", "").replace("_", "").isalnum():
        raise ValueError("Invalid STACK_NAME format")

    print(f"[AGENT] Creating Gateway MCP client for stack: {stack_name}")

    # Fetch Gateway URL from SSM
    gateway_url = get_ssm_parameter(f"/{stack_name}/gateway_url")
    print(f"[AGENT] Gateway URL from SSM: {gateway_url}")

    # Create MCP client with Bearer token authentication
    # CRITICAL: Call _fetch_gateway_token() INSIDE the lambda to get fresh token on reconnection
    gateway_client = MCPClient(
        lambda: streamablehttp_client(
            url=gateway_url, headers={"Authorization": f"Bearer {_fetch_gateway_token()}"}
        ),
        prefix="gateway",
    )

    print("[AGENT] Gateway MCP client created successfully")
    return gateway_client


def create_basic_agent(user_id: str, session_id: str) -> Agent:
    """
    Create a basic agent with AgentCore Gateway MCP tools and memory integration.

    This function sets up an agent that can access tools through the AgentCore Gateway
    and maintains conversation memory. It handles authentication, creates the MCP client
    connection, and configures the agent with access to all tools available through
    the Gateway. If Gateway connection fails, it falls back to an agent without tools.
    """
    system_prompt = get_system_prompt()

    bedrock_model = BedrockModel(
        model_id="au.anthropic.claude-sonnet-4-5-20250929-v1:0",
        temperature=0.1,
        cache_prompt="default",
        cache_tools="default",
    )

    memory_id = os.environ.get("MEMORY_ID")
    if not memory_id:
        raise ValueError("MEMORY_ID environment variable is required")

    # Configure AgentCore Memory with long-term retrieval strategies
    agentcore_memory_config = AgentCoreMemoryConfig(
        memory_id=memory_id,
        session_id=session_id,
        actor_id=user_id,
        retrieval_config={
            "/preferences/{actorId}": RetrievalConfig(top_k=5, relevance_score=0.7),
            "/facts/{actorId}": RetrievalConfig(top_k=10, relevance_score=0.3),
        },
    )

    session_manager = AgentCoreMemorySessionManager(
        agentcore_memory_config=agentcore_memory_config,
        region_name=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
    )

    # Initialize Code Interpreter tools with boto3 session
    region = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
    session = boto3.Session(region_name=region)
    code_tools = StrandsCodeInterpreterTools(region)

    try:
        print("[AGENT] Starting agent creation with Gateway tools...")

        # Get OAuth2 access token and create Gateway MCP client
        # The @requires_access_token decorator handles token fetching automatically
        print("[AGENT] Step 1: Creating Gateway MCP client (decorator handles OAuth2)...")
        gateway_client = create_gateway_mcp_client()
        print("[AGENT] Gateway MCP client created successfully")

        print(
            "[AGENT] Step 2: Creating Agent with Gateway tools and Code Interpreter..."
        )
        agent = Agent(
            name="BasicAgent",
            system_prompt=system_prompt,
            tools=[gateway_client, code_tools.execute_python_securely, web_fetch, request_approval],
            model=bedrock_model,
            session_manager=session_manager,
            trace_attributes={
                "user.id": user_id,
                "session.id": session_id,
            },
        )
        print(
            "[AGENT] Agent created successfully with Gateway tools and Code Interpreter"
        )
        return agent

    except Exception as e:
        print(f"[AGENT ERROR] Error creating Gateway client: {e}")
        print(f"[AGENT ERROR] Exception type: {type(e).__name__}")
        print("[AGENT ERROR] Traceback:")
        traceback.print_exc()
        print(
            "[AGENT] Gateway connection failed - raising exception instead of fallback"
        )
        raise


@app.entrypoint
async def agent_stream(payload, context: RequestContext):
    """
    Main entrypoint for the agent using streaming with Gateway integration.

    This is the function that AgentCore Runtime calls when the agent receives a request.
    It extracts the user's query from the payload, securely obtains the user ID from
    the validated JWT token in the request context, creates an agent with Gateway tools
    and memory, and streams the response back. This function handles the complete
    request lifecycle with token-level streaming. The user ID is extracted from the 
    JWT token (via RequestContext).
    """
    user_query = payload.get("prompt")
    session_id = payload.get("runtimeSessionId")

    if not all([user_query, session_id]):
        yield {
            "status": "error",
            "error": "Missing required fields: prompt or runtimeSessionId",
        }
        return

    try:
        # Extract user ID securely from the validated JWT token
        # instead of trusting the payload body (which could be manipulated)
        user_id = extract_user_id_from_context(context)

        print(
            f"[STREAM] Starting streaming invocation for user: {user_id}, session: {session_id}"
        )
        print(f"[STREAM] Query: {user_query}")

        agent = create_basic_agent(user_id, session_id)

        # Use the agent's stream_async method for true token-level streaming
        # Track tool calls for audit logging (Step 5b)
        # Strands event structure:
        #   tool_use start: event.contentBlockStart.start.toolUse.{toolUseId, name}
        #   tool_use input: event.current_tool_use.{toolUseId, name, input} (on type=tool_use_stream)
        #   tool_result:    message.content[].toolResult.{toolUseId, status, content}
        pending_tool_use = {}  # tool_use_id -> {name, input}
        async for event in agent.stream_async(user_query):
            event_dict = dict(event)

            # Capture tool_use start events (agent calling a tool)
            block_start = (event_dict.get("event", {})
                           .get("contentBlockStart", {})
                           .get("start", {})
                           .get("toolUse"))
            if block_start:
                tool_id = block_start.get("toolUseId", "")
                pending_tool_use[tool_id] = {
                    "name": block_start.get("name", "unknown"),
                    "input": None,
                }

            # Capture streamed tool input (last event has full input)
            current_tool = event_dict.get("current_tool_use")
            if current_tool and current_tool.get("input"):
                tool_id = current_tool.get("toolUseId", "")
                if tool_id in pending_tool_use:
                    pending_tool_use[tool_id]["input"] = current_tool.get("input")

            # Capture tool_result events and log the audit record
            message = event_dict.get("message", {})
            if message.get("role") == "user":
                for content_block in message.get("content", []):
                    tool_result = content_block.get("toolResult")
                    if tool_result:
                        tool_id = tool_result.get("toolUseId", "")
                        tool_info = pending_tool_use.pop(tool_id, {})
                        tool_name = tool_info.get("name", "unknown")
                        tool_input = tool_info.get("input")
                        # Extract text from toolResult content blocks
                        result_texts = [
                            c.get("text", "") for c in tool_result.get("content", [])
                        ]
                        tool_output = "\n".join(result_texts)
                        result_status = (
                            "error" if tool_result.get("status") == "error" else "success"
                        )

                        log_tool_call(
                            session_id=session_id,
                            user_id=user_id,
                            tool_name=tool_name,
                            tool_input=tool_input,
                            tool_output=tool_output,
                            result=result_status,
                        )

            yield json.loads(json.dumps(event_dict, default=str))

    except Exception as e:
        print(f"[STREAM ERROR] Error in agent_stream: {e}")
        traceback.print_exc()
        yield {"status": "error", "error": str(e)}


if __name__ == "__main__":
    app.run()
