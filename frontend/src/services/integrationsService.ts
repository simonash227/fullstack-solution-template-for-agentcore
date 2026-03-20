/**
 * Integrations Admin Service
 * Handles OAuth connection management for the Admin page.
 * Routes go to /integrations on the shared API Gateway (feedbackApiUrl base).
 */

let API_URL = ""

async function loadApiUrl(): Promise<string> {
  if (API_URL) return API_URL

  const response = await fetch("/aws-exports.json")
  const config = await response.json()
  API_URL = config.feedbackApiUrl || ""
  if (!API_URL) throw new Error("API URL not configured")
  return API_URL
}

export interface Integration {
  provider: string
  name: string
  status: "connected" | "not_connected" | "expired" | "not_configured"
  account?: string
  type: "oauth" | "admin"
}

export interface IntegrationsResponse {
  configured: boolean
  integrations: Integration[]
}

async function apiCall(
  path: string,
  idToken: string,
  options: RequestInit = {}
): Promise<Response> {
  const baseUrl = await loadApiUrl()
  const url = `${baseUrl.replace(/\/$/, "")}${path}`
  return fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
      ...options.headers,
    },
  })
}

export async function listIntegrations(
  idToken: string
): Promise<IntegrationsResponse> {
  const response = await apiCall("/integrations", idToken)
  if (!response.ok) throw new Error("Failed to list integrations")
  return response.json()
}

export async function getAuthUrl(
  idToken: string,
  provider: string
): Promise<string> {
  const response = await apiCall(`/integrations/${provider}/auth-url`, idToken)
  if (!response.ok) throw new Error(`Failed to get auth URL for ${provider}`)
  const data = await response.json()
  return data.url
}

export async function disconnectIntegration(
  idToken: string,
  provider: string
): Promise<void> {
  const response = await apiCall(`/integrations/${provider}`, idToken, {
    method: "DELETE",
  })
  if (!response.ok) throw new Error(`Failed to disconnect ${provider}`)
}
