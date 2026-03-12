import { Loader2 } from "lucide-react"

const toolLabels: Record<string, string> = {
  // Knowledge base / document search
  knowledge_base: "Searching your documents...",
  search_documents: "Searching your documents...",
  retrieve: "Searching your documents...",
  // Email / Outlook
  send_email: "Drafting email...",
  read_email: "Reading your emails...",
  list_emails: "Checking your inbox...",
  outlook: "Connecting to Outlook...",
  // Calendar
  calendar: "Checking your calendar...",
  list_events: "Looking at your schedule...",
  create_event: "Creating calendar event...",
  // Workspace
  workspace_manager: "Checking workspace files...",
  // General
  web_search: "Searching the web...",
  calculator: "Crunching numbers...",
}

function getStatusLabel(toolName: string | null): string {
  if (!toolName) return "Thinking..."

  // Check exact match first
  if (toolLabels[toolName]) return toolLabels[toolName]

  // Check partial match (tool names often have prefixes like "gateway___outlook___send_email")
  const lower = toolName.toLowerCase()
  for (const [key, label] of Object.entries(toolLabels)) {
    if (lower.includes(key)) return label
  }

  return "Working on it..."
}

type AgentStatusProps = {
  isLoading: boolean
  activeToolName?: string | null
}

export function AgentStatus({ isLoading, activeToolName }: AgentStatusProps) {
  if (!isLoading) return null

  const label = getStatusLabel(activeToolName ?? null)

  return (
    <div className="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span>{label}</span>
    </div>
  )
}
