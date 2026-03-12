import { AlertCircle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"

type ErrorBannerProps = {
  message: string
  onRetry?: () => void
  onDismiss?: () => void
}

const friendlyMessages: Record<string, string> = {
  "Failed to fetch": "Something went wrong connecting to the server. Check your internet connection and try again.",
  "Authentication required": "Your session has expired. Please sign in again.",
  "Network Error": "We couldn't reach the server. Check your connection and try again.",
}

export function ErrorBanner({ message, onRetry, onDismiss }: ErrorBannerProps) {
  const friendly = Object.entries(friendlyMessages).find(([key]) =>
    message.toLowerCase().includes(key.toLowerCase())
  )?.[1] || message

  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-4 mx-4 mt-3 flex items-start gap-3">
      <AlertCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-red-800">{friendly}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry} className="h-7 gap-1.5 text-red-700 border-red-300 hover:bg-red-100">
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        )}
        {onDismiss && (
          <button onClick={onDismiss} className="text-red-400 hover:text-red-600 text-sm px-1">
            Dismiss
          </button>
        )}
      </div>
    </div>
  )
}
