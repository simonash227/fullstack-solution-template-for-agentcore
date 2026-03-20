"""Xero Accounting connector Lambda for AgentCore Gateway.

Uses OAuth2 refresh token flow to access the Xero API.
Credentials stored in Secrets Manager at /agentcore/{client-id}/xero/oauth.

Important: Xero rotates refresh tokens on every use. This Lambda updates
the stored secret with the new refresh token after each token refresh.
"""

import json
import logging
import os
import re
from datetime import date, datetime, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen

logger = logging.getLogger()
logger.setLevel(logging.INFO)

XERO_API_BASE = "https://api.xero.com/api.xro/2.0"
XERO_TOKEN_URL = "https://identity.xero.com/connect/token"

# Cache token across Lambda invocations
_token_cache = {"access_token": None, "expires_at": 0}


def _get_secret():
    """Fetch Xero OAuth credentials from Secrets Manager."""
    import boto3

    client = boto3.client("secretsmanager")
    resp = client.get_secret_value(SecretId=os.environ["XERO_SECRET_ARN"])
    return json.loads(resp["SecretString"])


def _update_secret(secret_data):
    """Update the secret with the new refresh token after rotation."""
    import boto3

    client = boto3.client("secretsmanager")
    client.put_secret_value(
        SecretId=os.environ["XERO_SECRET_ARN"],
        SecretString=json.dumps(secret_data),
    )


def _get_access_token():
    """Get a Xero access token using refresh token flow.

    Xero rotates refresh tokens — each use returns a new one that must be stored.
    """
    now = datetime.now(timezone.utc).timestamp()
    if _token_cache["access_token"] and _token_cache["expires_at"] > now + 60:
        return _token_cache["access_token"]

    creds = _get_secret()

    data = urlencode({
        "grant_type": "refresh_token",
        "client_id": creds["client_id"],
        "client_secret": creds["client_secret"],
        "refresh_token": creds["refresh_token"],
    }).encode()

    req = Request(XERO_TOKEN_URL, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    with urlopen(req, timeout=10) as resp:
        token_data = json.loads(resp.read())

    _token_cache["access_token"] = token_data["access_token"]
    _token_cache["expires_at"] = now + token_data.get("expires_in", 1800)

    # Xero rotates refresh tokens — store the new one
    new_refresh = token_data.get("refresh_token")
    if new_refresh and new_refresh != creds["refresh_token"]:
        creds["refresh_token"] = new_refresh
        _update_secret(creds)
        logger.info("Xero refresh token rotated and stored.")

    return _token_cache["access_token"]


def _xero_request(path, params=None):
    """Make an authenticated request to the Xero API."""
    token = _get_access_token()
    creds = _get_secret()
    tenant_id = creds["tenant_id"]

    url = f"{XERO_API_BASE}{path}"
    if params:
        url += "?" + urlencode(params)

    req = Request(url, method="GET")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("xero-tenant-id", tenant_id)
    req.add_header("Accept", "application/json")

    from urllib.error import HTTPError as UrlHTTPError
    import gzip

    try:
        with urlopen(req, timeout=20) as resp:
            raw = resp.read()
            if resp.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            return json.loads(raw)
    except UrlHTTPError as e:
        raw = e.read()
        try:
            body = gzip.decompress(raw).decode("utf-8", errors="replace")
        except Exception:
            body = raw.decode("utf-8", errors="replace")
        logger.error(f"Xero API {e.code} for {url}: {body}")
        raise Exception(f"Xero API {e.code}: {body[:500]}")


def _parse_xero_date(date_str):
    """Parse Xero's MS JSON date format /Date(epoch_ms+offset)/ to YYYY-MM-DD."""
    if not date_str:
        return ""
    match = re.search(r"/Date\((\d+)", date_str)
    if match:
        epoch_ms = int(match.group(1))
        return datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
    return date_str


def _format_currency(amount, currency=""):
    """Format a number as currency."""
    if amount is None:
        return "$0.00"
    prefix = f"{currency} " if currency else "$"
    return f"{prefix}{amount:,.2f}"


def _format_report_rows(report):
    """Parse Xero's ReportWithRows structure into readable text."""
    if not report or "Reports" not in report or not report["Reports"]:
        return "No report data available."

    rpt = report["Reports"][0]
    lines = []

    titles = rpt.get("ReportTitles", [])
    if titles:
        lines.append(" | ".join(titles))
        lines.append("")

    for row in rpt.get("Rows", []):
        row_type = row.get("RowType", "")

        if row_type == "Header":
            cells = [c.get("Value", "") for c in row.get("Cells", [])]
            lines.append("  ".join(f"{c:<20}" for c in cells))
            lines.append("-" * 60)

        elif row_type == "Section":
            title = row.get("Title", "")
            if title:
                lines.append(f"\n**{title}**")
            for sub_row in row.get("Rows", []):
                sub_type = sub_row.get("RowType", "")
                cells = [c.get("Value", "") for c in sub_row.get("Cells", [])]
                if sub_type == "SummaryRow":
                    lines.append("-" * 60)
                    lines.append("  ".join(f"{c:<20}" for c in cells))
                else:
                    lines.append("  ".join(f"{c:<20}" for c in cells))

        elif row_type == "Row":
            cells = [c.get("Value", "") for c in row.get("Cells", [])]
            lines.append("  ".join(f"{c:<20}" for c in cells))

        elif row_type == "SummaryRow":
            cells = [c.get("Value", "") for c in row.get("Cells", [])]
            lines.append("=" * 60)
            lines.append("  ".join(f"{c:<20}" for c in cells))

    return "\n".join(lines)


# --- Tool implementations ---


def _executive_summary(event):
    report_date = event.get("date", date.today().isoformat())
    params = {"date": report_date}

    data = _xero_request("/Reports/ExecutiveSummary", params)
    return _format_report_rows(data)


def _profit_and_loss(event):
    today = date.today()
    from_date = event.get("from_date", today.replace(day=1).isoformat())
    to_date = event.get("to_date", today.isoformat())
    params = {"fromDate": from_date, "toDate": to_date}

    periods = event.get("periods")
    if periods:
        params["periods"] = min(periods, 12)
        params["timeframe"] = event.get("timeframe", "MONTH")

    data = _xero_request("/Reports/ProfitAndLoss", params)
    return _format_report_rows(data)


def _bank_summary(event):
    today = date.today()
    from_date = event.get("from_date", today.replace(day=1).isoformat())
    to_date = event.get("to_date", today.isoformat())
    params = {"fromDate": from_date, "toDate": to_date}

    data = _xero_request("/Reports/BankSummary", params)
    return _format_report_rows(data)


def _balance_sheet(event):
    report_date = event.get("date", date.today().isoformat())
    params = {"date": report_date}

    data = _xero_request("/Reports/BalanceSheet", params)
    return _format_report_rows(data)


def _list_invoices_or_bills(event, invoice_type):
    """Shared implementation for invoices (ACCREC) and bills (ACCPAY)."""
    status = event.get("status", "AUTHORISED").upper()
    from_date = event.get("from_date")
    contact_name = event.get("contact_name")
    max_results = min(event.get("max_results", 20), 50)

    # Build where filter
    where_parts = [f'Type=="{invoice_type}"']

    if status == "OVERDUE":
        where_parts.append('Status=="AUTHORISED"')
        where_parts.append(f'DueDate<DateTime({date.today().year},{date.today().month},{date.today().day})')
    elif status != "ALL":
        where_parts.append(f'Status=="{status}"')

    if from_date:
        parts = from_date.split("-")
        where_parts.append(f"Date>=DateTime({parts[0]},{int(parts[1])},{int(parts[2])})")

    params = {
        "where": "&&".join(where_parts),
        "order": "Date DESC",
        "page": "1",
        "pageSize": str(max_results),
    }

    data = _xero_request("/Invoices", params)
    invoices = data.get("Invoices", [])

    if not invoices:
        label = "invoices" if invoice_type == "ACCREC" else "bills"
        return f"No {label} found matching the criteria."

    lines = []
    total_due = 0
    label = "Invoice" if invoice_type == "ACCREC" else "Bill"

    for inv in invoices:
        inv_num = inv.get("InvoiceNumber", "—")
        contact = inv.get("Contact", {}).get("Name", "Unknown")
        inv_date = _parse_xero_date(inv.get("Date", ""))
        due_date = _parse_xero_date(inv.get("DueDate", ""))
        amount_due = inv.get("AmountDue", 0)
        total = inv.get("Total", 0)
        currency = inv.get("CurrencyCode", "")
        inv_status = inv.get("Status", "")
        total_due += amount_due

        # Check if overdue
        overdue = ""
        if inv_status == "AUTHORISED" and due_date:
            try:
                if datetime.strptime(due_date, "%Y-%m-%d").date() < date.today():
                    overdue = " [OVERDUE]"
            except ValueError:
                pass

        # Filter by contact name if specified
        if contact_name and contact_name.lower() not in contact.lower():
            continue

        lines.append(
            f"**{label} {inv_num}**{overdue}\n"
            f"  Contact: {contact}\n"
            f"  Date: {inv_date}  |  Due: {due_date}\n"
            f"  Total: {_format_currency(total, currency)}  |  Due: {_format_currency(amount_due, currency)}"
        )

    if not lines:
        return f"No {label.lower()}s found for contact '{contact_name}'."

    summary = f"Found {len(lines)} {label.lower()}(s). Total amount due: {_format_currency(total_due)}\n\n"
    return summary + "\n\n".join(lines)


def _list_invoices(event):
    return _list_invoices_or_bills(event, "ACCREC")


def _list_bills(event):
    return _list_invoices_or_bills(event, "ACCPAY")


def _list_contacts(event):
    search = event.get("search")
    is_customer = event.get("is_customer")
    max_results = min(event.get("max_results", 20), 50)

    params = {
        "page": "1",
        "pageSize": str(max_results),
        "order": "Name ASC",
    }

    if search:
        params["searchTerm"] = search

    where_parts = ['ContactStatus=="ACTIVE"']
    if is_customer is True:
        where_parts.append("IsCustomer==true")
    elif is_customer is False:
        where_parts.append("IsSupplier==true")

    params["where"] = "&&".join(where_parts)

    data = _xero_request("/Contacts", params)
    contacts = data.get("Contacts", [])

    if not contacts:
        return "No contacts found matching the criteria."

    lines = []
    for c in contacts:
        name = c.get("Name", "Unknown")
        email = c.get("EmailAddress", "")
        first = c.get("FirstName", "")
        last = c.get("LastName", "")
        is_cust = c.get("IsCustomer", False)
        is_supp = c.get("IsSupplier", False)

        role_parts = []
        if is_cust:
            role_parts.append("Customer")
        if is_supp:
            role_parts.append("Supplier")
        role = " & ".join(role_parts) if role_parts else "Contact"

        contact_person = f" ({first} {last})" if first or last else ""
        email_line = f"\n  Email: {email}" if email else ""

        phones = c.get("Phones", [])
        phone = ""
        for p in phones:
            if p.get("PhoneNumber"):
                area = p.get("PhoneAreaCode", "")
                num = p["PhoneNumber"]
                phone = f"\n  Phone: {area} {num}".strip()
                break

        lines.append(f"**{name}**{contact_person} [{role}]{email_line}{phone}")

    return f"Found {len(lines)} contact(s):\n\n" + "\n\n".join(lines)


# Tool routing table
TOOLS = {
    "xero_executive_summary": _executive_summary,
    "xero_profit_and_loss": _profit_and_loss,
    "xero_bank_summary": _bank_summary,
    "xero_balance_sheet": _balance_sheet,
    "xero_list_invoices": _list_invoices,
    "xero_list_bills": _list_bills,
    "xero_list_contacts": _list_contacts,
}


def handler(event, context):
    """Xero connector Lambda handler for AgentCore Gateway."""
    logger.info(f"Received event: {json.dumps(event)}")

    tool_name = None
    try:
        delimiter = "___"
        original_tool_name = context.client_context.custom["bedrockAgentCoreToolName"]
        tool_name = original_tool_name[
            original_tool_name.index(delimiter) + len(delimiter) :
        ]

        tool_fn = TOOLS.get(tool_name)
        if not tool_fn:
            return {"error": f"Unknown tool: {tool_name}. Available: {', '.join(TOOLS.keys())}"}

        result = tool_fn(event)

        return {
            "content": [{"type": "text", "text": result}],
        }

    except Exception as e:
        logger.error(f"Error in {tool_name or 'unknown'}: {str(e)}", exc_info=True)
        return {"error": f"Xero connector error: {str(e)}"}
