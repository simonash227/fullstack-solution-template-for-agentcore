import { useEffect, useState, useCallback, useRef } from "react"
import { ChevronDown, ChevronUp, Filter } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/hooks/useAuth"
import { listAuditRecords, type AuditRecord, type AuditResponse } from "@/services/auditService"
import { ErrorBanner } from "@/components/shared/ErrorBanner"

const systemLabels: Record<string, string> = {
  "strands-agent": "Agent",
  "kb-search": "Documents",
  "search_documents": "Documents",
  outlook: "Outlook",
  calendar: "Calendar",
  workspace_manager: "Workspace",
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

function getSystemLabel(action: string, system: string): string {
  const lower = action.toLowerCase()
  for (const [key, label] of Object.entries(systemLabels)) {
    if (lower.includes(key)) return label
  }
  return systemLabels[system] || system || "Agent"
}

type ActionLogProps = {
  /** If provided, only show actions from this session (inline chat panel mode) */
  sessionId?: string
  /** Class name for the container */
  className?: string
}

export function ActionLog({ sessionId: _sessionId, className = "" }: ActionLogProps) {
  const { token } = useAuth()
  const [records, setRecords] = useState<AuditRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nextToken, setNextToken] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [dateFilter, setDateFilter] = useState<string>(
    new Date().toISOString().split("T")[0]
  )
  const [showFilters, setShowFilters] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const loadRecords = useCallback(
    async (append = false) => {
      if (!token) return
      setLoading(true)
      setError(null)
      try {
        const response: AuditResponse = await listAuditRecords(token, {
          date: dateFilter || undefined,
          nextToken: append ? nextToken || undefined : undefined,
          limit: 20,
        })
        setRecords((prev) => (append ? [...prev, ...response.items] : response.items))
        setNextToken(response.nextToken)
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load action log")
      } finally {
        setLoading(false)
      }
    },
    [token, dateFilter, nextToken]
  )

  useEffect(() => {
    loadRecords()
  }, [token, dateFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }

  return (
    <div className={`flex flex-col h-full ${className}`}>
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
          {records.length} action{records.length !== 1 ? "s" : ""}
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

      {/* Error */}
      {error && (
        <ErrorBanner message={error} onRetry={() => loadRecords()} onDismiss={() => setError(null)} />
      )}

      {/* Records list */}
      <div className="flex-1 overflow-auto">
        {loading && records.length === 0 ? (
          <div className="text-center py-8 text-gray-500 text-sm">Loading actions...</div>
        ) : records.length === 0 ? (
          <div className="text-center py-8 text-gray-500 text-sm">
            No actions recorded{dateFilter ? ` for ${dateFilter}` : ""}.
          </div>
        ) : (
          <div className="divide-y">
            {records.map((record, i) => {
              const id = `${record.sessionId}-${record.timestamp}-${i}`
              const isExpanded = expandedId === id
              return (
                <div key={id} className="px-4 py-3 hover:bg-gray-50">
                  <button
                    className="w-full text-left flex items-start gap-3"
                    onClick={() => toggleExpand(id)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">
                          {record.action}
                        </span>
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded-full ${
                            resultColors[record.result] || "bg-gray-100 text-gray-700"
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
                    {isExpanded ? (
                      <ChevronUp className="h-4 w-4 text-gray-400 shrink-0 mt-1" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-gray-400 shrink-0 mt-1" />
                    )}
                  </button>

                  {isExpanded && (
                    <div className="mt-2 ml-0 text-xs space-y-2">
                      {record.inputSummary && (
                        <div>
                          <span className="font-medium text-gray-600">Input: </span>
                          <span className="text-gray-700 whitespace-pre-wrap break-words">
                            {record.inputSummary}
                          </span>
                        </div>
                      )}
                      {record.outputSummary && (
                        <div>
                          <span className="font-medium text-gray-600">Output: </span>
                          <span className="text-gray-700 whitespace-pre-wrap break-words">
                            {record.outputSummary}
                          </span>
                        </div>
                      )}
                      <div className="text-gray-400">
                        Session: {record.sessionId}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
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

        <div ref={bottomRef} />
      </div>
    </div>
  )
}
