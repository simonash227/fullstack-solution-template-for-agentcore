/**
 * Workspace Admin Service
 * Handles workspace file management and override operations for the Admin page.
 * Routes go to /workspace on the shared API Gateway (feedbackApiUrl base).
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

export interface WorkspaceFile {
  path: string
  category: string
  isOverridden: boolean
  isOverrideOnly?: boolean
  size: number
  lastModified: string
}

export interface WorkspaceFileContent {
  path: string
  core: string | null
  override: string | null
  active: "core" | "override"
}

export interface LearnedCategory {
  category: string
  count: number
  entries: LearnedEntry[]
}

export interface LearnedEntry {
  index: number
  content: string
  noted: string
  source: string
  type: string
  review: string
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

export async function listWorkspaceFiles(
  idToken: string
): Promise<WorkspaceFile[]> {
  const response = await apiCall("/workspace", idToken)
  if (!response.ok) throw new Error("Failed to list workspace files")
  const data = await response.json()
  return data.files || []
}

export async function readWorkspaceFile(
  idToken: string,
  path: string
): Promise<WorkspaceFileContent> {
  const response = await apiCall(
    `/workspace/file?path=${encodeURIComponent(path)}`,
    idToken
  )
  if (!response.ok) throw new Error("Failed to read workspace file")
  return response.json()
}

export async function saveWorkspaceFile(
  idToken: string,
  path: string,
  content: string
): Promise<void> {
  const response = await apiCall("/workspace/file", idToken, {
    method: "PUT",
    body: JSON.stringify({ path, content }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || "Failed to save workspace file")
  }
}

export async function resetToCore(
  idToken: string,
  path: string
): Promise<void> {
  const response = await apiCall(
    `/workspace/file?path=${encodeURIComponent(path)}`,
    idToken,
    { method: "DELETE" }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || "Failed to reset to core")
  }
}

export async function listLearnedEntries(
  idToken: string
): Promise<LearnedCategory[]> {
  const response = await apiCall("/workspace/learned", idToken)
  if (!response.ok) throw new Error("Failed to list learned entries")
  const data = await response.json()
  return data.categories || []
}

export async function editLearnedEntry(
  idToken: string,
  category: string,
  index: number,
  content: string
): Promise<void> {
  const response = await apiCall("/workspace/learned", idToken, {
    method: "PUT",
    body: JSON.stringify({ category, index, content }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || "Failed to edit learned entry")
  }
}

export async function deleteLearnedEntry(
  idToken: string,
  category: string,
  index: number
): Promise<void> {
  const response = await apiCall(
    `/workspace/learned?category=${encodeURIComponent(category)}&index=${index}`,
    idToken,
    { method: "DELETE" }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || "Failed to delete learned entry")
  }
}
