"use client"

import { Sparkles } from "lucide-react"

type QuickActionsProps = {
  actions: string[]
  onActionClick: (action: string) => void
}

/**
 * Displays clickable prompt starters for new conversations.
 * Actions are defined in aws-exports.json under the quickActions array.
 * Clicking an action pre-fills the chat input (does not auto-send).
 */
export function QuickActions({ actions, onActionClick }: QuickActionsProps) {
  if (actions.length === 0) return null

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 px-4 max-w-2xl mx-auto w-full">
      {actions.map((action, index) => (
        <button
          key={index}
          onClick={() => onActionClick(action)}
          className="flex items-start gap-2 p-3 text-left text-sm rounded-lg border border-gray-200 bg-white hover:bg-gray-50 hover:border-gray-300 transition-colors shadow-sm"
        >
          <Sparkles className="h-4 w-4 mt-0.5 shrink-0 text-gray-400" />
          <span className="text-gray-700">{action}</span>
        </button>
      ))}
    </div>
  )
}
