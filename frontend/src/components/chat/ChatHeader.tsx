import { Button } from "@/components/ui/button"
import { Plus, FileText } from "lucide-react"
import { useAuth } from "@/hooks/useAuth"
import { useNavigate } from "react-router-dom"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"

type ChatHeaderProps = {
  title?: string | undefined
  logoUrl?: string | null
  onNewChat: () => void
  canStartNewChat: boolean
}

export function ChatHeader({ title, logoUrl, onNewChat, canStartNewChat }: ChatHeaderProps) {
  const { isAuthenticated, signOut } = useAuth()
  const navigate = useNavigate()

  return (
    <header className="flex items-center justify-between p-4 border-b w-full">
      <div className="flex items-center gap-3">
        {logoUrl && (
          <img src={logoUrl} alt="Logo" className="h-8 w-auto" />
        )}
        <h1 className="text-xl font-bold">{title || "Fullstack AgentCore Solution Template"}</h1>
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={() => navigate("/documents")} variant="outline" className="gap-2">
          <FileText className="h-4 w-4" />
          Documents
        </Button>
        <Button onClick={onNewChat} variant="outline" className="gap-2" disabled={!canStartNewChat}>
          <Plus className="h-4 w-4" />
          New Chat
        </Button>
        {isAuthenticated && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline">Logout</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Confirm Logout</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to log out? You will need to sign in again to access your
                  account.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => signOut()}>Confirm</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </header>
  )
}
