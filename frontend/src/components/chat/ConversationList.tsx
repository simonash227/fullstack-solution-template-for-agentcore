import { MessageSquare, Plus, Trash2 } from "lucide-react"
import { useChat } from "@/app/context/ChatContext"
import { Button } from "@/components/ui/button"
import { useNavigate } from "react-router-dom"

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function ConversationList() {
  const {
    conversations,
    activeConversationId,
    startNewConversation,
    switchConversation,
    deleteConversation,
  } = useChat()
  const navigate = useNavigate()

  const handleNew = () => {
    startNewConversation()
    navigate("/")
  }

  const handleSwitch = (id: string) => {
    switchConversation(id)
    navigate("/")
  }

  // Only show conversations that have messages
  const nonEmpty = conversations.filter((c) => c.messages.length > 0)

  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="outline"
        size="sm"
        className="w-full gap-1.5 mb-1"
        onClick={handleNew}
      >
        <Plus className="h-4 w-4" />
        New Chat
      </Button>

      {nonEmpty.length === 0 && (
        <p className="text-xs text-muted-foreground px-2 py-1">No conversations yet</p>
      )}

      {nonEmpty.map((conv) => (
        <div
          key={conv.id}
          className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer transition-colors ${
            conv.id === activeConversationId
              ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
              : "hover:bg-sidebar-accent/50 text-sidebar-foreground"
          }`}
          onClick={() => handleSwitch(conv.id)}
        >
          <MessageSquare className="h-4 w-4 shrink-0 opacity-60" />
          <div className="flex-1 min-w-0">
            <p className="truncate text-xs">{conv.title}</p>
            <p className="text-[10px] text-muted-foreground">
              {formatRelativeTime(conv.updatedAt)}
            </p>
          </div>
          <button
            className="opacity-0 group-hover:opacity-100 p-1 text-muted-foreground hover:text-red-600 rounded transition-all"
            onClick={(e) => {
              e.stopPropagation()
              deleteConversation(conv.id)
            }}
            title="Delete conversation"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
