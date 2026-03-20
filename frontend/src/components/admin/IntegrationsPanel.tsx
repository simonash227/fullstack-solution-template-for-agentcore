import { useEffect, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import {
  ChevronDown,
  ChevronRight,
  Link2,
  Link2Off,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ExternalLink,
} from "lucide-react"
import {
  listIntegrations,
  getAuthUrl,
  disconnectIntegration,
  type Integration,
} from "@/services/integrationsService"

const PROVIDER_INFO: Record<
  string,
  { icon: string; connectLabel: string; description: string }
> = {
  gmail: {
    icon: "G",
    connectLabel: "Connect",
    description: "Read, send, and manage emails",
  },
  xero: {
    icon: "X",
    connectLabel: "Connect",
    description: "Financial reports, invoices, and accounting data",
  },
  slack: {
    icon: "S",
    connectLabel: "Add to Slack",
    description: "Send messages, read channels, and search conversations",
  },
  microsoft365: {
    icon: "M",
    connectLabel: "Connect",
    description: "Email, calendar, and file access via Microsoft Graph",
  },
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "connected":
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950 px-2 py-0.5 rounded-full">
          <CheckCircle2 className="h-3 w-3" />
          Connected
        </span>
      )
    case "expired":
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950 px-2 py-0.5 rounded-full">
          <AlertCircle className="h-3 w-3" />
          Expired
        </span>
      )
    case "not_configured":
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full">
          <XCircle className="h-3 w-3" />
          Not configured
        </span>
      )
    default:
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full">
          Not connected
        </span>
      )
  }
}

interface IntegrationsPanelProps {
  token: string
}

export function IntegrationsPanel({ token }: IntegrationsPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [configured, setConfigured] = useState(true)
  const [loading, setLoading] = useState(false)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadIntegrations = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const data = await listIntegrations(token)
      setIntegrations(data.integrations)
      setConfigured(data.configured)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load integrations")
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    if (token && expanded) loadIntegrations()
  }, [token, expanded, loadIntegrations])

  // Listen for OAuth popup completion
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "oauth-complete") {
        setConnecting(null)
        loadIntegrations()
      }
    }
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [loadIntegrations])

  const handleConnect = async (provider: string) => {
    setConnecting(provider)
    try {
      const url = await getAuthUrl(token, provider)
      const popup = window.open(url, "oauth-popup", "width=600,height=700")
      if (!popup) {
        // Popup blocked — open in new tab as fallback
        window.open(url, "_blank")
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : `Failed to start ${provider} connection`
      )
      setConnecting(null)
    }
  }

  const handleDisconnect = async (provider: string) => {
    setDisconnecting(provider)
    try {
      await disconnectIntegration(token, provider)
      await loadIntegrations()
    } catch (e) {
      setError(
        e instanceof Error ? e.message : `Failed to disconnect ${provider}`
      )
    } finally {
      setDisconnecting(null)
    }
  }

  const connectedCount = integrations.filter(
    (i) => i.status === "connected"
  ).length

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          <Link2 className="h-4 w-4" />
          <span className="font-medium">Integrations</span>
          <span className="text-sm text-muted-foreground">
            ({connectedCount} connected)
          </span>
        </div>
      </button>

      {expanded && (
        <div className="border-t">
          {error && (
            <div className="mx-4 mt-3 p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-800 dark:text-red-200">
              {error}
            </div>
          )}

          {!configured && (
            <div className="mx-4 mt-3 p-3 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg text-sm text-amber-800 dark:text-amber-200">
              Integrations not yet configured for this account. Contact your
              administrator to enable connections.
            </div>
          )}

          {loading ? (
            <div className="p-8 flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="divide-y">
              {integrations.map((integration) => {
                const info = PROVIDER_INFO[integration.provider] || {
                  icon: "?",
                  connectLabel: "Connect",
                  description: "",
                }
                const isOAuth = integration.type === "oauth"

                return (
                  <div
                    key={integration.provider}
                    className="flex items-center justify-between p-4"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-muted text-sm font-bold">
                        {info.icon}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">
                            {integration.name}
                          </span>
                          <StatusBadge status={integration.status} />
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {integration.status === "connected" &&
                          integration.account
                            ? integration.account
                            : integration.type === "admin"
                              ? "Configured by administrator"
                              : info.description}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {isOAuth &&
                        configured &&
                        integration.status !== "not_configured" && (
                          <>
                            {integration.status === "connected" ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  handleDisconnect(integration.provider)
                                }
                                disabled={
                                  disconnecting === integration.provider
                                }
                              >
                                {disconnecting === integration.provider ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <>
                                    <Link2Off className="h-4 w-4 mr-1" />
                                    Disconnect
                                  </>
                                )}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                onClick={() =>
                                  handleConnect(integration.provider)
                                }
                                disabled={connecting === integration.provider}
                              >
                                {connecting === integration.provider ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <>
                                    <ExternalLink className="h-4 w-4 mr-1" />
                                    {info.connectLabel}
                                  </>
                                )}
                              </Button>
                            )}
                          </>
                        )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
