"use client"

import { useEffect, useState, useCallback } from "react"
import { useAuth } from "@/hooks/useAuth"
import { Button } from "@/components/ui/button"
import {
  Settings,
  ChevronDown,
  ChevronRight,
  Pencil,
  Trash2,
  RotateCcw,
  X,
  Plus,
  FileText,
  BookOpen,
  AlertTriangle,
} from "lucide-react"
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  saveWorkspaceFile,
  resetToCore,
  listLearnedEntries,
  editLearnedEntry,
  deleteLearnedEntry,
  type WorkspaceFile,
  type WorkspaceFileContent,
  type LearnedCategory,
} from "@/services/workspaceService"
import { ErrorBanner } from "@/components/shared/ErrorBanner"
import { EmptyState } from "@/components/shared/EmptyState"
import { IntegrationsPanel } from "@/components/admin/IntegrationsPanel"

const CATEGORY_ORDER = ["root", "domains", "client"]
const CATEGORY_LABELS: Record<string, string> = {
  root: "Root Files",
  domains: "Domains",
  client: "Client Context",
}

function AdminContent() {
  const { token, isAuthenticated, signIn } = useAuth()

  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [learned, setLearned] = useState<LearnedCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Expanded categories
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set())
  const [learnedExpanded, setLearnedExpanded] = useState(false)

  // Editor state
  const [editFile, setEditFile] = useState<WorkspaceFileContent | null>(null)
  const [editPath, setEditPath] = useState("")
  const [editContent, setEditContent] = useState("")
  const [editTab, setEditTab] = useState<"override" | "core">("override")
  const [saving, setSaving] = useState(false)

  // Reset confirmation
  const [resetTarget, setResetTarget] = useState<string | null>(null)

  // New file dialog
  const [showNewFile, setShowNewFile] = useState(false)
  const [newFileCategory, setNewFileCategory] = useState("rooms")
  const [newFileName, setNewFileName] = useState("")

  // Learned edit
  const [learnedEdit, setLearnedEdit] = useState<{
    category: string
    index: number
    content: string
  } | null>(null)
  const [learnedDeleteTarget, setLearnedDeleteTarget] = useState<{
    category: string
    index: number
  } | null>(null)

  const loadData = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const [fileList, learnedList] = await Promise.all([
        listWorkspaceFiles(token),
        listLearnedEntries(token),
      ])
      setFiles(fileList)
      setLearned(learnedList)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load workspace")
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    if (token) loadData()
  }, [token, loadData])

  const toggleCategory = (cat: string) => {
    setExpandedCats((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  const handleCreateFile = () => {
    const name = newFileName.trim().replace(/\s+/g, "-").toLowerCase()
    if (!name) return
    const filename = name.endsWith(".md") ? name : `${name}.md`
    const prefix = newFileCategory === "root" ? "" : `${newFileCategory}/`
    const path = `${prefix}${filename}`

    // Open editor with empty content for a new override-only file
    setEditFile({
      path,
      core: null,
      override: null,
      active: "core",
    })
    setEditPath(path)
    setEditContent(`# ${name.replace(/-/g, " ").replace(/\.md$/, "")}\n\n`)
    setEditTab("override")
    setShowNewFile(false)
    setNewFileName("")
  }

  const openEditor = async (path: string) => {
    if (!token) return
    setError(null)
    try {
      const fileContent = await readWorkspaceFile(token, path)
      setEditFile(fileContent)
      setEditPath(path)
      setEditContent(fileContent.override ?? fileContent.core ?? "")
      setEditTab(fileContent.override !== null ? "override" : "override")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read file")
    }
  }

  const handleSave = async () => {
    if (!token || !editPath) return
    setSaving(true)
    setError(null)
    try {
      await saveWorkspaceFile(token, editPath, editContent)
      setEditFile(null)
      setEditPath("")
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    if (!token || !resetTarget) return
    setError(null)
    try {
      await resetToCore(token, resetTarget)
      setResetTarget(null)
      setEditFile(null)
      setEditPath("")
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reset")
    }
  }

  const handleLearnedEdit = async () => {
    if (!token || !learnedEdit) return
    setError(null)
    try {
      await editLearnedEntry(
        token,
        learnedEdit.category,
        learnedEdit.index,
        learnedEdit.content
      )
      setLearnedEdit(null)
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update entry")
    }
  }

  const handleLearnedDelete = async () => {
    if (!token || !learnedDeleteTarget) return
    setError(null)
    try {
      await deleteLearnedEntry(
        token,
        learnedDeleteTarget.category,
        learnedDeleteTarget.index
      )
      setLearnedDeleteTarget(null)
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete entry")
    }
  }

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-full">
        <Button onClick={() => signIn()}>Sign in to access admin</Button>
      </div>
    )
  }

  // Group files by category
  const grouped: Record<string, WorkspaceFile[]> = {}
  for (const f of files) {
    if (!grouped[f.category]) grouped[f.category] = []
    grouped[f.category].push(f)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-6 border-b flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Workspace Admin</h1>
          <p className="text-sm text-muted-foreground mt-1">
            View and override workspace files. Core files update on next
            deployment.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setShowNewFile(true)}
        >
          <Plus className="h-4 w-4 mr-1" />
          New File
        </Button>
      </div>

      {/* Warning banner */}
      <div className="mx-6 mt-4 p-3 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
        <p className="text-sm text-amber-800 dark:text-amber-200">
          Edits create per-client overrides. Core files update on next
          deployment. Use "Reset to core" to remove an override.
        </p>
      </div>

      {error && (
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      )}

      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="text-center text-muted-foreground py-12">
            Loading...
          </div>
        ) : files.length === 0 ? (
          <EmptyState
            icon={Settings}
            title="No workspace files"
            description="Deploy workspace files first using deploy-workspace.py."
          />
        ) : (
          <div className="space-y-2">
            {/* Workspace file categories */}
            {CATEGORY_ORDER.map((cat) => {
              const catFiles = grouped[cat]
              if (!catFiles || catFiles.length === 0) return null
              return (
                <div
                  key={cat}
                  className="border rounded-lg overflow-hidden"
                >
                  <button
                    className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
                    onClick={() => toggleCategory(cat)}
                  >
                    <div className="flex items-center gap-2">
                      {expandedCats.has(cat) ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                      <FileText className="h-4 w-4" />
                      <span className="font-medium">
                        {CATEGORY_LABELS[cat] || cat}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        ({catFiles.length})
                      </span>
                    </div>
                  </button>

                  {expandedCats.has(cat) && (
                    <div className="border-t divide-y">
                      {catFiles.map((f) => (
                        <div
                          key={f.path}
                          className="p-3 px-4 flex items-center justify-between gap-4"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-sm font-mono truncate">
                              {f.path}
                            </span>
                            {f.isOverridden ? (
                              <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300">
                                Customised
                              </span>
                            ) : (
                              <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
                                Core
                              </span>
                            )}
                          </div>
                          <div className="flex gap-1 shrink-0">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEditor(f.path)}
                            >
                              <Pencil className="h-3 w-3" />
                            </Button>
                            {f.isOverridden && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setResetTarget(f.path)}
                                title="Reset to core"
                              >
                                <RotateCcw className="h-3 w-3" />
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Learned knowledge section */}
            <div className="border rounded-lg overflow-hidden">
              <button
                className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
                onClick={() => setLearnedExpanded(!learnedExpanded)}
              >
                <div className="flex items-center gap-2">
                  {learnedExpanded ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                  <BookOpen className="h-4 w-4" />
                  <span className="font-medium">Learned Knowledge</span>
                  <span className="text-sm text-muted-foreground">
                    ({learned.reduce((sum, c) => sum + c.count, 0)} entries)
                  </span>
                </div>
              </button>

              {learnedExpanded && (
                <div className="border-t">
                  {learned.length === 0 ? (
                    <div className="p-4 text-sm text-muted-foreground">
                      No learned knowledge yet
                    </div>
                  ) : (
                    <div className="divide-y">
                      {learned.map((cat) => (
                        <div key={cat.category} className="p-4">
                          <h4 className="text-sm font-medium mb-2 capitalize">
                            {cat.category} ({cat.count})
                          </h4>
                          {cat.entries.map((entry) => (
                            <div
                              key={`${cat.category}-${entry.index}`}
                              className="flex items-start justify-between gap-4 py-2 pl-4"
                            >
                              {learnedEdit &&
                              learnedEdit.category === cat.category &&
                              learnedEdit.index === entry.index ? (
                                <div className="flex-1 space-y-2">
                                  <textarea
                                    value={learnedEdit.content}
                                    onChange={(e) =>
                                      setLearnedEdit({
                                        ...learnedEdit,
                                        content: e.target.value,
                                      })
                                    }
                                    className="w-full border rounded p-2 text-sm min-h-[60px]"
                                    maxLength={500}
                                  />
                                  <div className="flex gap-2">
                                    <Button
                                      size="sm"
                                      onClick={handleLearnedEdit}
                                    >
                                      Save
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => setLearnedEdit(null)}
                                    >
                                      Cancel
                                    </Button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <div className="flex-1">
                                    <p className="text-sm">{entry.content}</p>
                                    <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                                      <span>Noted: {entry.noted}</span>
                                      <span>Type: {entry.type}</span>
                                      <span>Source: {entry.source}</span>
                                    </div>
                                  </div>
                                  <div className="flex gap-1 shrink-0">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() =>
                                        setLearnedEdit({
                                          category: cat.category,
                                          index: entry.index,
                                          content: entry.content,
                                        })
                                      }
                                    >
                                      <Pencil className="h-3 w-3" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() =>
                                        setLearnedDeleteTarget({
                                          category: cat.category,
                                          index: entry.index,
                                        })
                                      }
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  </div>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Integrations section */}
            {token && <IntegrationsPanel token={token} />}
          </div>
        )}
      </div>

      {/* New file dialog */}
      {showNewFile && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background border rounded-lg p-6 max-w-md mx-4 w-full">
            <h3 className="font-semibold">Create New File</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Creates a client-specific override file.
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="text-sm font-medium">Category</label>
                <select
                  value={newFileCategory}
                  onChange={(e) => setNewFileCategory(e.target.value)}
                  className="w-full border rounded px-3 py-2 text-sm mt-1"
                >
                  <option value="rooms">Rooms</option>
                  <option value="skills">Skills</option>
                  <option value="client">Client Context</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-medium">Filename</label>
                <div className="flex items-center gap-1 mt-1">
                  <span className="text-sm text-muted-foreground">
                    {newFileCategory}/
                  </span>
                  <input
                    type="text"
                    value={newFileName}
                    onChange={(e) => setNewFileName(e.target.value)}
                    placeholder="my-file.md"
                    className="flex-1 border rounded px-3 py-2 text-sm font-mono"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreateFile()
                    }}
                  />
                </div>
              </div>
            </div>
            <div className="flex gap-2 mt-4 justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowNewFile(false)
                  setNewFileName("")
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleCreateFile}
                disabled={!newFileName.trim()}
              >
                Create
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* File editor modal */}
      {editFile && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-background border rounded-lg w-full max-w-4xl h-[80vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b">
              <div>
                <h3 className="font-semibold font-mono text-sm">
                  {editPath}
                </h3>
                <p className="text-xs text-muted-foreground mt-1">
                  {editFile.core === null && editFile.override === null
                    ? "New client-specific file"
                    : editFile.active === "override"
                      ? "Editing override version"
                      : "Creating new override from core"}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditFile(null)
                  setEditPath("")
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Tabs when file has both versions */}
            {editFile.core !== null && editFile.override !== null && (
              <div className="flex border-b">
                <button
                  className={`px-4 py-2 text-sm ${
                    editTab === "override"
                      ? "border-b-2 border-primary font-medium"
                      : "text-muted-foreground"
                  }`}
                  onClick={() => {
                    setEditTab("override")
                    setEditContent(editFile.override ?? "")
                  }}
                >
                  Override (editable)
                </button>
                <button
                  className={`px-4 py-2 text-sm ${
                    editTab === "core"
                      ? "border-b-2 border-primary font-medium"
                      : "text-muted-foreground"
                  }`}
                  onClick={() => {
                    setEditTab("core")
                  }}
                >
                  Core (read-only)
                </button>
              </div>
            )}

            {/* Content */}
            <div className="flex-1 overflow-hidden p-4">
              {editTab === "core" && editFile.core !== null ? (
                <pre className="w-full h-full overflow-auto p-3 bg-muted rounded text-sm font-mono whitespace-pre-wrap">
                  {editFile.core}
                </pre>
              ) : (
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  className="w-full h-full border rounded p-3 text-sm font-mono resize-none"
                  spellCheck={false}
                />
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between p-4 border-t">
              <div className="text-xs text-muted-foreground">
                {editContent.length} characters
              </div>
              <div className="flex gap-2">
                {editFile.override !== null && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setResetTarget(editPath)}
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />
                    Reset to core
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditFile(null)
                    setEditPath("")
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={saving || editTab === "core"}
                >
                  {saving ? "Saving..." : "Save override"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reset confirmation dialog */}
      {resetTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background border rounded-lg p-6 max-w-sm mx-4">
            <h3 className="font-semibold">Reset to core version?</h3>
            <p className="text-sm text-muted-foreground mt-2">
              This will delete the override for{" "}
              <code className="text-xs">{resetTarget}</code> and revert to the
              deployed core version.
            </p>
            <div className="flex gap-2 mt-4 justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setResetTarget(null)}
              >
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={handleReset}>
                Reset to core
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Learned delete confirmation */}
      {learnedDeleteTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background border rounded-lg p-6 max-w-sm mx-4">
            <h3 className="font-semibold">Delete learned entry?</h3>
            <p className="text-sm text-muted-foreground mt-2">
              This will permanently remove this knowledge entry.
            </p>
            <div className="flex gap-2 mt-4 justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLearnedDeleteTarget(null)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleLearnedDelete}
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function AdminPage() {
  return <AdminContent />
}
