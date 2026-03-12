"use client"

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  PropsWithChildren,
} from "react"
import { Message } from "@/components/chat/types"

const STORAGE_KEY = "agentcore-conversations"
const MAX_STORED_CONVERSATIONS = 20

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: string
  updatedAt: string
}

interface ChatContextType {
  conversations: Conversation[]
  activeConversationId: string | null
  activeMessages: Message[]
  setActiveMessages: (messages: Message[] | ((prev: Message[]) => Message[])) => void
  startNewConversation: () => string
  switchConversation: (id: string) => void
  deleteConversation: (id: string) => void
}

const ChatContext = createContext<ChatContextType | undefined>(undefined)

export function useChat(): ChatContextType {
  const context = useContext(ChatContext)
  if (context === undefined) {
    throw new Error("useChat must be used within a ChatContextProvider")
  }
  return context
}

function generateTitle(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === "user")
  if (!firstUser) return "New conversation"
  const text = firstUser.content.trim()
  if (text.length <= 50) return text
  return text.slice(0, 47) + "..."
}

function loadConversations(): Conversation[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return []
    return JSON.parse(stored)
  } catch {
    return []
  }
}

function saveConversations(conversations: Conversation[]) {
  try {
    // Keep only the most recent conversations
    const trimmed = conversations.slice(0, MAX_STORED_CONVERSATIONS)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    // localStorage full or unavailable — silently fail
  }
}

export function ChatContextProvider({ children }: PropsWithChildren) {
  const [conversations, setConversations] = useState<Conversation[]>(() =>
    loadConversations()
  )
  const [activeId, setActiveId] = useState<string | null>(() => {
    const loaded = loadConversations()
    return loaded.length > 0 ? loaded[0].id : null
  })

  // Persist to localStorage whenever conversations change
  useEffect(() => {
    saveConversations(conversations)
  }, [conversations])

  const activeConversation = conversations.find((c) => c.id === activeId) || null

  const setActiveMessages = useCallback(
    (updater: Message[] | ((prev: Message[]) => Message[])) => {
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === activeId)
        if (idx === -1) return prev

        const current = prev[idx]
        const newMessages =
          typeof updater === "function" ? updater(current.messages) : updater
        const updated: Conversation = {
          ...current,
          messages: newMessages,
          title: generateTitle(newMessages) || current.title,
          updatedAt: new Date().toISOString(),
        }

        const newConvs = [...prev]
        newConvs[idx] = updated
        // Move active conversation to top
        newConvs.splice(idx, 1)
        newConvs.unshift(updated)
        return newConvs
      })
    },
    [activeId]
  )

  const startNewConversation = useCallback(() => {
    const id = crypto.randomUUID()
    const newConv: Conversation = {
      id,
      title: "New conversation",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    setConversations((prev) => [newConv, ...prev].slice(0, MAX_STORED_CONVERSATIONS))
    setActiveId(id)
    return id
  }, [])

  const switchConversation = useCallback((id: string) => {
    setActiveId(id)
  }, [])

  const deleteConversation = useCallback(
    (id: string) => {
      setConversations((prev) => {
        const filtered = prev.filter((c) => c.id !== id)
        if (activeId === id) {
          setActiveId(filtered.length > 0 ? filtered[0].id : null)
        }
        return filtered
      })
    },
    [activeId]
  )

  // If no active conversation exists, create one
  useEffect(() => {
    if (!activeId && conversations.length === 0) {
      startNewConversation()
    }
  }, [activeId, conversations.length, startNewConversation])

  return (
    <ChatContext.Provider
      value={{
        conversations,
        activeConversationId: activeId,
        activeMessages: activeConversation?.messages || [],
        setActiveMessages,
        startNewConversation,
        switchConversation,
        deleteConversation,
      }}
    >
      {children}
    </ChatContext.Provider>
  )
}
