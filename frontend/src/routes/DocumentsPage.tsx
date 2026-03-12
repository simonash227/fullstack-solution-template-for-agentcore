"use client"

import { useEffect, useState, useRef, useCallback } from "react"
import { useAuth } from "@/hooks/useAuth"
import { Button } from "@/components/ui/button"
import {
  Upload,
  Trash2,
  Download,
  FileText,
  ArrowUpDown,
  RefreshCw,
} from "lucide-react"
import {
  listDocuments,
  uploadFile,
  deleteDocument,
  getDownloadUrl,
  type DocumentItem,
} from "@/services/documentsService"
import { ErrorBanner } from "@/components/shared/ErrorBanner"
import { EmptyState } from "@/components/shared/EmptyState"

type SortField = "name" | "lastModified" | "size"
type SortDir = "asc" | "desc"

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function DocumentsContent() {
  const { token, isAuthenticated, signIn } = useAuth()

  const [documents, setDocuments] = useState<DocumentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [uploading, setUploading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DocumentItem | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [sortField, setSortField] = useState<SortField>("lastModified")
  const [sortDir, setSortDir] = useState<SortDir>("desc")

  const fileInputRef = useRef<HTMLInputElement>(null)

  const loadDocuments = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const docs = await listDocuments(token)
      setDocuments(docs)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load documents")
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    if (token) loadDocuments()
  }, [token, loadDocuments])

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !token) return

    setUploading(true)
    setUploadProgress(0)
    setError(null)

    try {
      await uploadFile(token, file, setUploadProgress)
      setUploadProgress(100)
      await loadDocuments()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setUploading(false)
      setUploadProgress(null)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget || !token) return
    setDeleting(true)
    try {
      await deleteDocument(token, deleteTarget.key)
      setDeleteTarget(null)
      await loadDocuments()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed")
    } finally {
      setDeleting(false)
    }
  }

  const handleDownload = async (doc: DocumentItem) => {
    if (!token) return
    try {
      const url = await getDownloadUrl(token, doc.key)
      window.open(url, "_blank")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed")
    }
  }

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortField(field)
      setSortDir(field === "name" ? "asc" : "desc")
    }
  }

  const sortedDocs = [...documents].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1
    if (sortField === "name") return a.name.localeCompare(b.name) * dir
    if (sortField === "size") return (a.size - b.size) * dir
    return (
      (new Date(a.lastModified).getTime() - new Date(b.lastModified).getTime()) *
      dir
    )
  })

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <p className="text-4xl font-bold">Please sign in</p>
        <Button onClick={() => signIn()}>Sign In</Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-6 py-3 bg-white border-b">
        <span className="text-sm text-gray-500">
          {documents.length} file{documents.length !== 1 ? "s" : ""}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={loadDocuments}
            disabled={loading}
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          </Button>
          <Button
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <Upload size={16} className="mr-1" />
            Upload
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".pdf,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.txt,.csv,.md,.rtf,.html,.htm,.json"
            onChange={handleUpload}
          />
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <ErrorBanner
          message={error}
          onRetry={loadDocuments}
          onDismiss={() => setError(null)}
        />
      )}

      {/* Upload progress */}
      {uploading && uploadProgress !== null && (
        <div className="mx-6 mt-4">
          <div className="bg-white rounded-lg border p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">Uploading...</span>
              <span className="text-sm text-gray-500">{uploadProgress}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Document list */}
      <div className="flex-1 overflow-auto mx-6 mt-4">
        {loading && documents.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            Loading documents...
          </div>
        ) : documents.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No documents yet"
            description="Upload contracts, board papers, financials — your agent will be able to search and cite them."
            actionLabel="Upload your first document"
            onAction={() => fileInputRef.current?.click()}
          />
        ) : (
          <div className="bg-white rounded-lg border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-600">
                    <button
                      className="flex items-center gap-1 hover:text-gray-900"
                      onClick={() => toggleSort("name")}
                    >
                      Name
                      <ArrowUpDown size={14} />
                    </button>
                  </th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 w-20">
                    Type
                  </th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 w-24">
                    <button
                      className="flex items-center gap-1 hover:text-gray-900"
                      onClick={() => toggleSort("size")}
                    >
                      Size
                      <ArrowUpDown size={14} />
                    </button>
                  </th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 w-48">
                    <button
                      className="flex items-center gap-1 hover:text-gray-900"
                      onClick={() => toggleSort("lastModified")}
                    >
                      Uploaded
                      <ArrowUpDown size={14} />
                    </button>
                  </th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600 w-28">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedDocs.map((doc) => (
                  <tr
                    key={doc.key}
                    className="border-b last:border-b-0 hover:bg-gray-50"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <FileText size={16} className="text-gray-400 shrink-0" />
                        <span className="truncate" title={doc.name}>
                          {doc.name}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{doc.type}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {formatFileSize(doc.size)}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {formatDate(doc.lastModified)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleDownload(doc)}
                          className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                          title="Download"
                        >
                          <Download size={16} />
                        </button>
                        <button
                          onClick={() => setDeleteTarget(doc)}
                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                          title="Delete"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
            <h3 className="text-lg font-semibold mb-2">Delete document</h3>
            <p className="text-gray-600 text-sm mb-1">
              This will permanently remove{" "}
              <strong>{deleteTarget.name}</strong>. The agent will no longer
              be able to reference it.
            </p>
            <p className="text-gray-500 text-xs mb-4">
              Previous versions are retained for 90 days as a safety net.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Delete"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function DocumentsPage() {
  return <DocumentsContent />
}
