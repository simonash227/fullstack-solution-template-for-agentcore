import { useEffect, useState, useCallback, useMemo } from "react"
import {
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  Filter,
  Printer,
  Clock,
  Activity,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/hooks/useAuth"
import {
  listAuditRecords,
  type AuditRecord,
  type AuditResponse,
} from "@/services/auditService"
import { ErrorBanner } from "@/components/shared/ErrorBanner"
import { EmptyState } from "@/components/shared/EmptyState"

// --- Shared helpers ---

const systemLabels: Record<string, string> = {
  "strands-agent": "Agent",
  "kb-search": "Documents",
  search_documents: "Documents",
  outlook: "Outlook",
  calendar: "Calendar",
  workspace_manager: "Workspace",
  gmail: "Gmail",
  m365: "M365",
  web_fetch: "Web",
}

const resultColors: Record<string, string> = {
  success: "bg-green-100 text-green-800",
  error: "bg-red-100 text-red-800",
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })
}

function getSystemLabel(action: string, system: string): string {
  const lower = action.toLowerCase()
  for (const [key, label] of Object.entries(systemLabels)) {
    if (lower.includes(key)) return label
  }
  return systemLabels[system] || system || "Agent"
}

// --- Types ---

interface SessionSummary {
  sessionId: string
  firstTimestamp: string
  lastTimestamp: string
  actionCount: number
  systems: string[]
  successCount: number
  errorCount: number
}

// --- Session list (grouped view) ---

function groupBySession(records: AuditRecord[]): SessionSummary[] {
  const map = new Map<string, AuditRecord[]>()
  for (const r of records) {
    const list = map.get(r.sessionId) || []
    list.push(r)
    map.set(r.sessionId, list)
  }

  const summaries: SessionSummary[] = []
  for (const [sessionId, items] of map) {
    const sorted = items.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    )
    const systems = [...new Set(items.map((i) => getSystemLabel(i.action, i.system)))]
    summaries.push({
      sessionId,
      firstTimestamp: sorted[0].timestamp,
      lastTimestamp: sorted[sorted.length - 1].timestamp,
      actionCount: items.length,
      systems,
      successCount: items.filter((i) => i.result === "success").length,
      errorCount: items.filter((i) => i.result === "error").length,
    })
  }

  return summaries.sort(
    (a, b) =>
      new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime()
  )
}

// --- Components ---

function SessionCard({
  session,
  onClick,
}: {
  session: SessionSummary
  onClick: () => void
}) {
  return (
    <button
      className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b transition-colors"
      onClick={onClick}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-gray-400" />
          <span className="text-sm font-medium">
            {session.actionCount} action{session.actionCount !== 1 ? "s" : ""}
          </span>
          {session.errorCount > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-red-100 text-red-800">
              {session.errorCount} failed
            </span>
          )}
        </div>
        <ChevronDown className="h-4 w-4 text-gray-400" />
      </div>
      <div className="flex items-center gap-2 mt-1">
        <span className="text-xs text-gray-500">
          {formatDate(session.firstTimestamp)} {formatTime(session.firstTimestamp)}
          {" - "}
          {formatTime(session.lastTimestamp)}
        </span>
      </div>
      <div className="flex flex-wrap gap-1 mt-1.5">
        {session.systems.map((sys) => (
          <span
            key={sys}
            className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600"
          >
            {sys}
          </span>
        ))}
      </div>
    </button>
  )
}

function SessionDetail({
  sessionId,
  token,
  onBack,
}: {
  sessionId: string
  token: string
  onBack: () => void
}) {
  const [records, setRecords] = useState<AuditRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const allItems: AuditRecord[] = []
      let nextToken: string | undefined
      // Fetch all records for this session (paginate if needed)
      do {
        const response: AuditResponse = await listAuditRecords(token, {
          sessionId,
          limit: 50,
          nextToken,
        })
        allItems.push(...response.items)
        nextToken = response.nextToken || undefined
      } while (nextToken && allItems.length < 500)
      // Sort chronologically
      allItems.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      )
      setRecords(allItems)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load session details")
    } finally {
      setLoading(false)
    }
  }, [token, sessionId])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-white print:hidden">
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" />
          Back
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">
            {records.length} action{records.length !== 1 ? "s" : ""}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => window.print()}
          >
            <Printer className="h-3.5 w-3.5" />
            Export
          </Button>
        </div>
      </div>

      {/* Print header (hidden on screen) */}
      <div className="hidden print:block px-4 py-3 border-b">
        <h1 className="text-lg font-bold">Audit Report</h1>
        {records.length > 0 && (
          <p className="text-sm text-gray-600">
            Session: {sessionId}
            <br />
            {formatDate(records[0].timestamp)} {formatTime(records[0].timestamp)}
            {" - "}
            {formatTime(records[records.length - 1].timestamp)}
            <br />
            {records.length} action{records.length !== 1 ? "s" : ""}
          </p>
        )}
      </div>

      {error && (
        <ErrorBanner
          message={error}
          onRetry={loadAll}
          onDismiss={() => setError(null)}
        />
      )}

      {/* Records */}
      <div className="flex-1 overflow-auto print:overflow-visible">
        {loading ? (
          <div className="text-center py-8 text-gray-500 text-sm">
            Loading session...
          </div>
        ) : records.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="No actions found"
            description="This session has no recorded actions."
          />
        ) : (
          <div className="divide-y">
            {records.map((record, i) => {
              const id = `${record.sessionId}-${record.timestamp}-${i}`
              const isExpanded = expandedId === id
              return (
                <div
                  key={id}
                  className="px-4 py-3 hover:bg-gray-50 print:hover:bg-white print:break-inside-avoid"
                >
                  <button
                    className="w-full text-left flex items-start gap-3 print:cursor-default"
                    onClick={() => setExpandedId(isExpanded ? null : id)}
                  >
                    {/* Step number */}
                    <span className="text-xs font-mono text-gray-400 mt-0.5 w-6 text-right shrink-0">
                      {i + 1}.
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">
                          {record.action}
                        </span>
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded-full ${
                            resultColors[record.result] ||
                            "bg-gray-100 text-gray-700"
                          }`}
                        >
                          {record.result}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-gray-500">
                          {getSystemLabel(record.action, record.system)}
                        </span>
                        <span className="text-xs text-gray-400">
                          {formatTimestamp(record.timestamp)}
                        </span>
                      </div>
                    </div>
                    <span className="print:hidden">
                      {isExpanded ? (
                        <ChevronUp className="h-4 w-4 text-gray-400 shrink-0 mt-1" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-gray-400 shrink-0 mt-1" />
                      )}
                    </span>
                  </button>

                  {/* Detail (expanded on screen, always visible in print) */}
                  <div
                    className={`mt-2 ml-9 text-xs space-y-2 ${
                      isExpanded ? "" : "hidden print:block"
                    }`}
                  >
                    {record.inputSummary && (
                      <div>
                        <span className="font-medium text-gray-600">
                          Input:{" "}
                        </span>
                        <span className="text-gray-700 whitespace-pre-wrap break-words">
                          {record.inputSummary}
                        </span>
                      </div>
                    )}
                    {record.outputSummary && (
                      <div>
                        <span className="font-medium text-gray-600">
                          Output:{" "}
                        </span>
                        <span className="text-gray-700 whitespace-pre-wrap break-words">
                          {record.outputSummary}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// --- Main page ---

export default function HistoryPage() {
  const { isAuthenticated, signIn, token } = useAuth()
  const [records, setRecords] = useState<AuditRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nextToken, setNextToken] = useState<string | null>(null)
  const [dateFilter, setDateFilter] = useState<string>("")
  const [showFilters, setShowFilters] = useState(false)
  const [selectedSession, setSelectedSession] = useState<string | null>(null)

  const loadRecords = useCallback(
    async (append = false) => {
      if (!token) return
      setLoading(true)
      setError(null)
      try {
        const response: AuditResponse = await listAuditRecords(token, {
          date: dateFilter || undefined,
          nextToken: append ? nextToken || undefined : undefined,
          limit: 50,
        })
        setRecords((prev) =>
          append ? [...prev, ...response.items] : response.items
        )
        setNextToken(response.nextToken)
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load history")
      } finally {
        setLoading(false)
      }
    },
    [token, dateFilter, nextToken]
  )

  useEffect(() => {
    if (token) loadRecords()
  }, [token, dateFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  const sessions = useMemo(() => groupBySession(records), [records])

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-4xl font-bold">Please sign in</p>
        <Button onClick={() => signIn()}>Sign In</Button>
      </div>
    )
  }

  // Drill-down view
  if (selectedSession && token) {
    return (
      <SessionDetail
        sessionId={selectedSession}
        token={token}
        onBack={() => setSelectedSession(null)}
      />
    )
  }

  // Sessions list view
  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-white">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setShowFilters(!showFilters)}
        >
          <Filter className="h-3.5 w-3.5" />
          Filter
        </Button>
        <span className="text-xs text-gray-500">
          {sessions.length} session{sessions.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="px-4 py-2 border-b bg-gray-50 flex items-center gap-3">
          <label className="text-xs text-gray-600">Date:</label>
          <input
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            className="text-sm border rounded px-2 py-1"
          />
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={() => setDateFilter("")}
          >
            Clear
          </Button>
        </div>
      )}

      {error && (
        <ErrorBanner
          message={error}
          onRetry={() => loadRecords()}
          onDismiss={() => setError(null)}
        />
      )}

      {/* Sessions list */}
      <div className="flex-1 overflow-auto">
        {loading && sessions.length === 0 ? (
          <div className="text-center py-8 text-gray-500 text-sm">
            Loading history...
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState
            icon={Clock}
            title="No sessions yet"
            description={
              dateFilter
                ? `No agent sessions recorded for ${dateFilter}.`
                : "Agent activity will appear here once you start chatting."
            }
          />
        ) : (
          <>
            {sessions.map((session) => (
              <SessionCard
                key={session.sessionId}
                session={session}
                onClick={() => setSelectedSession(session.sessionId)}
              />
            ))}
          </>
        )}

        {/* Load more */}
        {nextToken && !loading && (
          <div className="px-4 py-3 text-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => loadRecords(true)}
            >
              Load more
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
