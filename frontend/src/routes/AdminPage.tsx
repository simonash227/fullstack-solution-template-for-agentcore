import { Settings } from "lucide-react"
import { EmptyState } from "@/components/shared/EmptyState"

export default function AdminPage() {
  return (
    <EmptyState
      icon={Settings}
      title="Admin"
      description="User management and settings will be available here in a future update."
    />
  )
}
