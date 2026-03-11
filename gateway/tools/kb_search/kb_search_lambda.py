import json
import logging
import os
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

bedrock_agent_runtime = boto3.client("bedrock-agent-runtime")

KNOWLEDGE_BASE_ID = os.environ["KNOWLEDGE_BASE_ID"]


def handler(event, context):
    """
    Knowledge Base search tool Lambda for AgentCore Gateway.

    Calls Bedrock Knowledge Base Retrieve API and returns passages
    with source document metadata for inline citations.
    """
    logger.info(f"Received event: {json.dumps(event)}")

    try:
        delimiter = "___"
        original_tool_name = context.client_context.custom["bedrockAgentCoreToolName"]
        tool_name = original_tool_name[
            original_tool_name.index(delimiter) + len(delimiter) :
        ]

        if tool_name != "search_documents":
            return {"error": f"Unexpected tool: {tool_name}"}

        query = event.get("query", "")
        max_results = min(event.get("max_results", 5), 10)

        if not query:
            return {"error": "query parameter is required"}

        response = bedrock_agent_runtime.retrieve(
            knowledgeBaseId=KNOWLEDGE_BASE_ID,
            retrievalQuery={"text": query},
            retrievalConfiguration={
                "vectorSearchConfiguration": {
                    "numberOfResults": max_results,
                }
            },
        )

        results = []
        for item in response.get("retrievalResults", []):
            content = item.get("content", {})
            location = item.get("location", {})
            score = item.get("score", 0)

            # Extract source document name from S3 URI
            source_uri = ""
            source_name = ""
            if location.get("type") == "S3":
                source_uri = location.get("s3Location", {}).get("uri", "")
                # Extract filename from s3://bucket/path/filename.ext
                source_name = source_uri.rsplit("/", 1)[-1] if source_uri else ""

            results.append({
                "text": content.get("text", ""),
                "source_name": source_name,
                "source_uri": source_uri,
                "relevance_score": round(score, 4),
            })

        # Format response for the agent with citation-friendly structure
        if not results:
            return {
                "content": [
                    {
                        "type": "text",
                        "text": "No relevant documents found for that query.",
                    }
                ]
            }

        formatted = "Document search results:\n\n"
        for i, r in enumerate(results, 1):
            formatted += f"[Source: {r['source_name']}, relevance: {r['relevance_score']}]\n"
            formatted += f"{r['text']}\n\n"

        return {
            "content": [{"type": "text", "text": formatted}],
            # Include structured metadata for citation UI rendering
            "metadata": {"citations": results},
        }

    except Exception as e:
        logger.error(f"Error: {str(e)}")
        return {"error": f"Document search failed: {str(e)}"}
