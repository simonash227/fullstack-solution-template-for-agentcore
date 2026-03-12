"use client"

import { useEffect, useState, useCallback } from "react"
import { useAuth } from "@/hooks/useAuth"
import { Button } from "@/components/ui/button"
import {
  Plus,
  Pencil,
  Trash2,
  Undo2,
  ChevronDown,
  ChevronRight,
  BookOpen,
} from "lucide-react"
import {
  listCategories,
  listEntries,
  addEntry,
  updateEntry,
  deleteEntry,
  undoLastChange,
  type KnowledgeCategory,
  type KnowledgeEntry,
} from "@/services/knowledgeService"
import { ErrorBanner } from "@/components/shared/ErrorBanner"
import { EmptyState } from "@/components/shared/EmptyState"

const CATEGORY_LABELS: Record<string, string> = {
  policies: "Policies",
  "people-updates": "People & Team",
  "key-dates": "Key Dates",
  preferences: "Preferences",
}

const ENTRY_TYPES = ["fact", "policy", "temporary", "preference"]

function KnowledgeContent() {
  const { token, isAuthenticated, signIn } = useAuth()

  const [categories, setCategories] = useState<KnowledgeCategory[]>([])
  const [expandedCat, setExpandedCat] = useState<string | null>(null)
  const [entries, setEntries] = useState<KnowledgeEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [entriesLoading, setEntriesLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Add form
  const [showAddForm, setShowAddForm] = useState(false)
  const [newContent, setNewContent] = useState("")
  const [newType, setNewType] = useState("fact")
  const [addingTo, setAddingTo] = useState<string | null>(null)

  // Edit state
  const [editIndex, setEditIndex] = useState<number | null>(null)
  const [editContent, setEditContent] = useState("")

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<{
    category: string
    index: number
  } | null>(null)

  const loadCategories = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const cats = await listCategories(token)
      setCategories(cats)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }, [token])

  const loadEntries = useCallback(
    async (category: string) => {
      if (!token) return
      setEntriesLoading(true)
      try {
        const ents = await listEntries(token, category)
        setEntries(ents)
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load entries")
      } finally {
        setEntriesLoading(false)
      }
    },
    [token]
  )

  useEffect(() => {
    if (token) loadCategories()
  }, [token, loadCategories])

  const toggleCategory = (cat: string) => {
    if (expandedCat === cat) {
      setExpandedCat(null)
      setEntries([])
    } else {
      setExpandedCat(cat)
      loadEntries(cat)
    }
    setShowAddForm(false)
    setEditIndex(null)
  }

  const handleAdd = async () => {
    if (!token || !addingTo || !newContent.trim()) return
    setError(null)
    try {
      await addEntry(token, addingTo, newContent.trim(), newType)
      setNewContent("")
      setShowAddForm(false)
      await loadEntries(addingTo)
      await loadCategories()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add")
    }
  }

  const handleUpdate = async (category: string, index: number) => {
    if (!token || !editContent.trim()) return
    setError(null)
    try {
      await updateEntry(token, category, index, editContent.trim())
      setEditIndex(null)
      await loadEntries(category)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update")
    }
  }

  const handleDelete = async () => {
    if (!token || !deleteTarget) return
    setError(null)
    try {
      await deleteEntry(token, deleteTarget.category, deleteTarget.index)
      setDeleteTarget(null)
      await loadEntries(deleteTarget.category)
      await loadCategories()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete")
    }
  }

  const handleUndo = async (category: string) => {
    if (!token) return
    setError(null)
    try {
      await undoLastChange(token, category)
      await loadEntries(category)
      await loadCategories()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to undo")
    }
  }

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-full">
        <Button onClick={() => signIn()}>Sign in to view knowledge</Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-6 border-b">
        <h1 className="text-2xl font-semibold">What I Know</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Knowledge the agent has been asked to remember. You can view, edit, or
          remove entries.
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
        ) : categories.length === 0 ||
          categories.every((c) => c.count === 0) ? (
          <EmptyState
            icon={BookOpen}
            title="No knowledge yet"
            description='The agent will store knowledge here when you say things like "Remember that..." in chat.'
          />
        ) : (
          <div className="space-y-2">
            {categories.map((cat) => (
              <div
                key={cat.category}
                className="border rounded-lg overflow-hidden"
              >
                {/* Category header */}
                <button
                  className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
                  onClick={() => toggleCategory(cat.category)}
                >
                  <div className="flex items-center gap-2">
                    {expandedCat === cat.category ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                    <span className="font-medium">
                      {CATEGORY_LABELS[cat.category] || cat.category}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      ({cat.count})
                    </span>
                  </div>
                  {expandedCat === cat.category && (
                    <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleUndo(cat.category)}
                        title="Undo last change"
                      >
                        <Undo2 className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setAddingTo(cat.category)
                          setShowAddForm(true)
                        }}
                      >
                        <Plus className="h-4 w-4 mr-1" />
                        Add
                      </Button>
                    </div>
                  )}
                </button>

                {/* Entries */}
                {expandedCat === cat.category && (
                  <div className="border-t">
                    {entriesLoading ? (
                      <div className="p-4 text-sm text-muted-foreground">
                        Loading...
                      </div>
                    ) : entries.length === 0 ? (
                      <div className="p-4 text-sm text-muted-foreground">
                        No entries yet
                      </div>
                    ) : (
                      <div className="divide-y">
                        {entries.map((entry) => (
                          <div
                            key={entry.index}
                            className="p-4 flex items-start justify-between gap-4"
                          >
                            {editIndex === entry.index ? (
                              <div className="flex-1 space-y-2">
                                <textarea
                                  value={editContent}
                                  onChange={(e) =>
                                    setEditContent(e.target.value)
                                  }
                                  className="w-full border rounded p-2 text-sm min-h-[60px]"
                                  maxLength={500}
                                />
                                <div className="flex gap-2">
                                  <Button
                                    size="sm"
                                    onClick={() =>
                                      handleUpdate(cat.category, entry.index)
                                    }
                                  >
                                    Save
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setEditIndex(null)}
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
                                    onClick={() => {
                                      setEditIndex(entry.index)
                                      setEditContent(entry.content)
                                    }}
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                      setDeleteTarget({
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
                    )}

                    {/* Add form */}
                    {showAddForm && addingTo === cat.category && (
                      <div className="border-t p-4 space-y-3 bg-muted/30">
                        <textarea
                          value={newContent}
                          onChange={(e) => setNewContent(e.target.value)}
                          placeholder="What should the agent remember?"
                          className="w-full border rounded p-2 text-sm min-h-[60px]"
                          maxLength={500}
                        />
                        <div className="flex items-center gap-3">
                          <select
                            value={newType}
                            onChange={(e) => setNewType(e.target.value)}
                            className="border rounded px-2 py-1 text-sm"
                          >
                            {ENTRY_TYPES.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                          <Button size="sm" onClick={handleAdd}>
                            Add
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setShowAddForm(false)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background border rounded-lg p-6 max-w-sm mx-4">
            <h3 className="font-semibold">Delete entry?</h3>
            <p className="text-sm text-muted-foreground mt-2">
              This entry will be removed. You can undo this using the undo
              button.
            </p>
            <div className="flex gap-2 mt-4 justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDeleteTarget(null)}
              >
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={handleDelete}>
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function KnowledgePage() {
  return <KnowledgeContent />
}
