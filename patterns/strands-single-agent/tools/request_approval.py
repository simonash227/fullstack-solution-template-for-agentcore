"""Approval gate tool — pauses the agent to request user confirmation before sensitive actions.

The agent calls this tool before performing any action that modifies external systems
(sending emails, creating records, deleting data, etc.). The tool returns a formatted
approval request that the frontend renders as an interactive card. The user's next
message ("approved" or "rejected") determines whether the agent proceeds.
"""

from strands import tool


@tool
def request_approval(action_type: str, summary: str, details: str) -> str:
    """Request user approval before performing a sensitive action.

    IMPORTANT: You MUST call this tool and wait for the user's response before
    performing any action that sends data, modifies records, or deletes anything.

    Args:
        action_type: Short label for the action (e.g., "Send Email", "Delete File", "Create Event")
        summary: One-line description of what will happen (e.g., "Send email to john@acme.com")
        details: Full details for the user to review (e.g., the email subject, body, and recipients)

    Returns:
        A formatted approval request. Wait for the user's next message before proceeding.
    """
    return (
        f"[APPROVAL_REQUIRED]\n"
        f"Action: {action_type}\n"
        f"Summary: {summary}\n"
        f"Details:\n{details}\n"
        f"[/APPROVAL_REQUIRED]\n\n"
        f"I need your approval before proceeding. Please confirm or reject this action."
    )
