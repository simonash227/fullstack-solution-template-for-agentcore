"""Cognito User Pool Backup Lambda (Step 5d).

Scheduled weekly via EventBridge. Exports all users from the Cognito user pool
to a JSON file in S3 with KMS encryption. Publishes a CloudWatch metric on
success or failure so alarms can fire if backups stop working.

Environment variables:
    USER_POOL_ID: Cognito user pool ID
    BACKUP_BUCKET: S3 bucket name for backups
    KMS_KEY_ARN: KMS key ARN for server-side encryption
    STACK_NAME: Stack name for CloudWatch metric dimension
"""

import json
import os
from datetime import datetime, timezone

import boto3


def handler(event, context):
    user_pool_id = os.environ["USER_POOL_ID"]
    backup_bucket = os.environ["BACKUP_BUCKET"]
    kms_key_arn = os.environ["KMS_KEY_ARN"]
    stack_name = os.environ.get("STACK_NAME", "unknown")

    cognito = boto3.client("cognito-idp")
    s3 = boto3.client("s3")
    cloudwatch = boto3.client("cloudwatch")

    try:
        # Paginate through all users
        users = []
        params = {"UserPoolId": user_pool_id, "Limit": 60}
        while True:
            response = cognito.list_users(**params)
            for user in response["Users"]:
                users.append({
                    "Username": user["Username"],
                    "Attributes": [
                        {"Name": a["Name"], "Value": a["Value"]}
                        for a in user.get("Attributes", [])
                    ],
                    "UserCreateDate": user["UserCreateDate"].isoformat(),
                    "UserLastModifiedDate": user["UserLastModifiedDate"].isoformat(),
                    "Enabled": user["Enabled"],
                    "UserStatus": user["UserStatus"],
                })
            pagination_token = response.get("PaginationToken")
            if not pagination_token:
                break
            params["PaginationToken"] = pagination_token

        # Write to S3
        now = datetime.now(timezone.utc)
        key = f"cognito-backups/{now.strftime('%Y/%m/%d')}/users-{now.strftime('%Y%m%dT%H%M%SZ')}.json"
        body = json.dumps({
            "exportDate": now.isoformat(),
            "userPoolId": user_pool_id,
            "userCount": len(users),
            "users": users,
        }, indent=2)

        s3.put_object(
            Bucket=backup_bucket,
            Key=key,
            Body=body.encode("utf-8"),
            ServerSideEncryption="aws:kms",
            SSEKMSKeyId=kms_key_arn,
            ContentType="application/json",
        )

        print(f"[BACKUP] Exported {len(users)} users to s3://{backup_bucket}/{key}")

        # Publish success metric
        cloudwatch.put_metric_data(
            Namespace="AgentCore/Operations",
            MetricData=[{
                "MetricName": "CognitoBackupSuccess",
                "Value": 1,
                "Unit": "Count",
                "Dimensions": [{"Name": "StackName", "Value": stack_name}],
            }],
        )

        return {"statusCode": 200, "body": f"Exported {len(users)} users"}

    except Exception as e:
        print(f"[BACKUP ERROR] {e}")

        # Publish failure metric
        cloudwatch.put_metric_data(
            Namespace="AgentCore/Operations",
            MetricData=[{
                "MetricName": "CognitoBackupSuccess",
                "Value": 0,
                "Unit": "Count",
                "Dimensions": [{"Name": "StackName", "Value": stack_name}],
            }],
        )

        raise
