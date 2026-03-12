export interface AuditRecord {
  sessionId: string
  timestamp: string
  userId: string
  action: string
  system: string
  result: string
  inputSummary?: string
  outputSummary?: string
  datePrefix: string
  workflowId?: string
}

export interface AuditResponse {
  items: AuditRecord[]
  nextToken: string | null
  count: number
}

let cachedApiUrl: string | null = null

async function getApiUrl(): Promise<string> {
  if (cachedApiUrl) return cachedApiUrl
  const response = await fetch("/aws-exports.json")
  const config = await response.json()
  // Audit API lives on the same REST API as feedback
  cachedApiUrl = config.feedbackApiUrl
  return cachedApiUrl!
}

export async function listAuditRecords(
  token: string,
  params?: { date?: string; sessionId?: string; action?: string; limit?: number; nextToken?: string }
): Promise<AuditResponse> {
  const apiUrl = await getApiUrl()
  const searchParams = new URLSearchParams()
  if (params?.date) searchParams.set("date", params.date)
  if (params?.sessionId) searchParams.set("sessionId", params.sessionId)
  if (params?.action) searchParams.set("action", params.action)
  if (params?.limit) searchParams.set("limit", String(params.limit))
  if (params?.nextToken) searchParams.set("nextToken", params.nextToken)

  const qs = searchParams.toString()
  const url = `${apiUrl}audit${qs ? `?${qs}` : ""}`

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch audit records: ${response.statusText}`)
  }

  return response.json()
}
