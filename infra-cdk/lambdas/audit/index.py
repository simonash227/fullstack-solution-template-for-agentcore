"""Audit Log API Lambda Handler — query agent action history from DynamoDB."""

import os
from typing import Any, Dict, Optional

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig
from aws_lambda_powertools.logging.correlation_paths import API_GATEWAY_REST
from aws_lambda_powertools.utilities.typing import LambdaContext
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

TABLE_NAME = os.environ["TABLE_NAME"]
CORS_ALLOWED_ORIGINS = os.environ.get("CORS_ALLOWED_ORIGINS", "*")

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

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)

tracer = Tracer()
logger = Logger()
app = APIGatewayRestResolver(cors=cors_config)

MAX_PAGE_SIZE = 50
DEFAULT_PAGE_SIZE = 20
# Cache key params: date, sessionId, action, limit, nextToken


def get_user_id(event) -> Optional[str]:
    """Extract user ID from Cognito JWT claims."""
    request_context = event.request_context
    authorizer = request_context.authorizer
    claims = authorizer.get("claims", {}) if authorizer else {}
    return claims.get("sub")


@app.get("/audit")
def list_audit_records() -> Dict[str, Any]:
    """
    GET /audit — list audit records for the current user.

    Query params:
      - date: YYYY-MM-DD (filter by date, uses datePrefix-timestamp-index)
      - sessionId: filter by session (queries main table by PK, chronological order)
      - action: filter by action/tool name
      - limit: page size (default 20, max 50)
      - nextToken: pagination token (base64-encoded lastEvaluatedKey)
    """
    user_id = get_user_id(app.current_event)
    if not user_id:
        return {"error": "Unauthorized"}, 401

    params = app.current_event.query_string_parameters or {}
    date_filter = params.get("date")
    action_filter = params.get("action")
    session_filter = params.get("sessionId")
    limit = min(int(params.get("limit", DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE)
    next_token = params.get("nextToken")

    try:
        if session_filter:
            # Query main table by sessionId PK, filter by userId for auth
            from boto3.dynamodb.conditions import Attr

            query_kwargs = {
                "KeyConditionExpression": Key("sessionId").eq(session_filter),
                "FilterExpression": Attr("userId").eq(user_id),
                "ScanIndexForward": True,
                "Limit": min(limit, 200),
            }
        elif date_filter:
            # Use datePrefix-timestamp-index, then filter by userId
            query_kwargs = {
                "IndexName": "datePrefix-timestamp-index",
                "KeyConditionExpression": Key("datePrefix").eq(date_filter),
                "FilterExpression": Key("userId").eq(user_id),
                "ScanIndexForward": False,
                "Limit": limit,
            }
        else:
            # Use userId-timestamp-index (most common query)
            query_kwargs = {
                "IndexName": "userId-timestamp-index",
                "KeyConditionExpression": Key("userId").eq(user_id),
                "ScanIndexForward": False,
                "Limit": limit,
            }

        if action_filter:
            from boto3.dynamodb.conditions import Attr

            existing_filter = query_kwargs.get("FilterExpression")
            action_cond = Attr("action").eq(action_filter)
            if existing_filter:
                query_kwargs["FilterExpression"] = existing_filter & action_cond
            else:
                query_kwargs["FilterExpression"] = action_cond

        if next_token:
            import json
            import base64

            query_kwargs["ExclusiveStartKey"] = json.loads(
                base64.b64decode(next_token).decode("utf-8")
            )

        response = table.query(**query_kwargs)

        items = response.get("Items", [])

        # Build pagination token
        result_next_token = None
        if "LastEvaluatedKey" in response:
            import json
            import base64

            result_next_token = base64.b64encode(
                json.dumps(response["LastEvaluatedKey"]).encode("utf-8")
            ).decode("utf-8")

        return {
            "items": items,
            "nextToken": result_next_token,
            "count": len(items),
        }

    except ClientError as e:
        logger.error(f"DynamoDB error: {e.response['Error']['Message']}")
        return {"error": "Internal server error"}, 500

    except Exception as e:
        logger.error(f"Error querying audit records: {str(e)}")
        return {"error": "Internal server error"}, 500


@logger.inject_lambda_context(correlation_id_path=API_GATEWAY_REST)
def handler(event: dict, context: LambdaContext) -> dict:
    return app.resolve(event, context)
