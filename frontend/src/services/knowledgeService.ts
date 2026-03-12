/**
 * Knowledge Service
 * Handles CRUD for learned knowledge entries ("What I Know" page).
 * Routes go to /knowledge on the shared API Gateway (feedbackApiUrl base).
 */

let API_URL = ""

async function loadApiUrl(): Promise<string> {
  if (API_URL) return API_URL

  const response = await fetch("/aws-exports.json")
  const config = await response.json()
  // Knowledge API is on the shared API (same as feedback/audit/health)
  API_URL = config.feedbackApiUrl || ""
  if (!API_URL) throw new Error("API URL not configured")
  return API_URL
}

export interface KnowledgeCategory {
  category: string
  count: number
}

export interface KnowledgeEntry {
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

export async function listCategories(idToken: string): Promise<KnowledgeCategory[]> {
  const response = await apiCall("/knowledge", idToken)
  if (!response.ok) throw new Error("Failed to list categories")
  const data = await response.json()
  return data.categories || []
}

export async function listEntries(
  idToken: string,
  category: string
): Promise<KnowledgeEntry[]> {
  const response = await apiCall(`/knowledge/${category}`, idToken)
  if (!response.ok) throw new Error("Failed to list entries")
  const data = await response.json()
  return data.entries || []
}

export async function addEntry(
  idToken: string,
  category: string,
  content: string,
  type: string = "fact"
): Promise<void> {
  const response = await apiCall(`/knowledge/${category}`, idToken, {
    method: "POST",
    body: JSON.stringify({ content, type }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || "Failed to add entry")
  }
}

export async function updateEntry(
  idToken: string,
  category: string,
  index: number,
  content: string
): Promise<void> {
  const response = await apiCall(`/knowledge/${category}/${index}`, idToken, {
    method: "PUT",
    body: JSON.stringify({ content }),
  })
  if (!response.ok) throw new Error("Failed to update entry")
}

export async function deleteEntry(
  idToken: string,
  category: string,
  index: number
): Promise<void> {
  const response = await apiCall(`/knowledge/${category}/${index}`, idToken, {
    method: "DELETE",
  })
  if (!response.ok) throw new Error("Failed to delete entry")
}

export async function undoLastChange(
  idToken: string,
  category: string
): Promise<void> {
  const response = await apiCall(`/knowledge/${category}/undo`, idToken, {
    method: "POST",
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || "Failed to undo")
  }
}
