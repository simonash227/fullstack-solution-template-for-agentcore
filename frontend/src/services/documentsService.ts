/**
 * Documents Service
 * Handles document listing, upload (presigned URLs), download, delete, and KB sync.
 */

let DOCUMENTS_API_URL = ""

async function loadApiUrl(): Promise<string> {
  if (DOCUMENTS_API_URL) return DOCUMENTS_API_URL

  const response = await fetch("/aws-exports.json")
  const config = await response.json()
  DOCUMENTS_API_URL = config.documentsApiUrl || ""
  if (!DOCUMENTS_API_URL) throw new Error("Documents API URL not configured")
  return DOCUMENTS_API_URL
}

export interface DocumentItem {
  key: string
  name: string
  size: number
  lastModified: string
  type: string
}

async function apiCall(
  path: string,
  idToken: string,
  options: RequestInit = {}
): Promise<Response> {
  const baseUrl = await loadApiUrl()
  // baseUrl ends with /prod/ — strip trailing slash if path starts with /
  const url = `${baseUrl.replace(/\/$/, "")}${path}`
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
      ...options.headers,
    },
  })
  return response
}

export async function listDocuments(idToken: string): Promise<DocumentItem[]> {
  const response = await apiCall("/documents", idToken)
  if (!response.ok) throw new Error("Failed to list documents")
  const data = await response.json()
  return data.documents || []
}

export async function getUploadUrl(
  idToken: string,
  filename: string,
  contentType: string
): Promise<{ uploadUrl: string; key: string }> {
  const response = await apiCall("/documents/upload-url", idToken, {
    method: "POST",
    body: JSON.stringify({ filename, contentType }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || "Failed to get upload URL")
  }
  return response.json()
}

export async function uploadFile(
  idToken: string,
  file: File,
  onProgress?: (percent: number) => void
): Promise<string> {
  // Get presigned URL
  const { uploadUrl, key } = await getUploadUrl(idToken, file.name, file.type || "application/octet-stream")

  // Upload directly to S3 via presigned URL with progress tracking
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", uploadUrl)
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream")

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`Upload failed: ${xhr.status}`))
    }
    xhr.onerror = () => reject(new Error("Upload failed"))
    xhr.send(file)
  })

  // Trigger KB ingestion after upload
  await apiCall("/documents/sync", idToken, { method: "POST" })

  return key
}

export async function getDownloadUrl(
  idToken: string,
  key: string
): Promise<string> {
  const response = await apiCall("/documents/download-url", idToken, {
    method: "POST",
    body: JSON.stringify({ key }),
  })
  if (!response.ok) throw new Error("Failed to get download URL")
  const data = await response.json()
  return data.downloadUrl
}

export async function deleteDocument(
  idToken: string,
  key: string
): Promise<void> {
  const encoded = encodeURIComponent(key)
  const response = await apiCall(`/documents/${encoded}`, idToken, {
    method: "DELETE",
  })
  if (!response.ok) throw new Error("Failed to delete document")
}
