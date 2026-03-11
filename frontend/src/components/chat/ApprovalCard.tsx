"use client"

import { useState } from "react"
import { ShieldAlert, Check, X } from "lucide-react"

interface ApprovalCardProps {
  actionType: string
  summary: string
  details: string
  onApprove: () => void
  onReject: () => void
  disabled?: boolean
}

export function ApprovalCard({
  actionType,
  summary,
  details,
  onApprove,
  onReject,
  disabled = false,
}: ApprovalCardProps) {
  const [responded, setResponded] = useState<"approved" | "rejected" | null>(null)

  const handleApprove = () => {
    setResponded("approved")
    onApprove()
  }

  const handleReject = () => {
    setResponded("rejected")
    onReject()
  }

  return (
    <div className="my-3 border border-amber-200 bg-amber-50 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-100 border-b border-amber-200">
        <ShieldAlert size={16} className="text-amber-600" />
        <span className="font-medium text-amber-800 text-sm">
          Approval Required — {actionType}
        </span>
      </div>

      {/* Body */}
      <div className="px-4 py-3 space-y-2">
        <p className="text-sm font-medium text-gray-800">{summary}</p>
        <pre className="text-xs text-gray-600 whitespace-pre-wrap break-words bg-white border border-gray-200 rounded p-3 max-h-48 overflow-y-auto">
          {details}
        </pre>
      </div>

      {/* Actions */}
      <div className="px-4 py-3 border-t border-amber-200 flex gap-2">
        {responded === null ? (
          <>
            <button
              onClick={handleApprove}
              disabled={disabled}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-green-600 text-white text-sm font-medium rounded hover:bg-green-700 disabled:opacity-50 transition-colors"
            >
              <Check size={14} />
              Approve
            </button>
            <button
              onClick={handleReject}
              disabled={disabled}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-gray-200 text-gray-700 text-sm font-medium rounded hover:bg-gray-300 disabled:opacity-50 transition-colors"
            >
              <X size={14} />
              Reject
            </button>
          </>
        ) : responded === "approved" ? (
          <span className="flex items-center gap-1.5 text-sm text-green-700 font-medium">
            <Check size={14} />
            Approved
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-sm text-red-600 font-medium">
            <X size={14} />
            Rejected
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Parse an approval request from tool result text.
 * Returns null if the text doesn't contain an approval block.
 */
export function parseApprovalRequest(text: string): {
  actionType: string
  summary: string
  details: string
} | null {
  const match = text.match(
    /\[APPROVAL_REQUIRED\]\s*\nAction:\s*(.+)\nSummary:\s*(.+)\nDetails:\s*\n([\s\S]*?)\n\[\/APPROVAL_REQUIRED\]/
  )
  if (!match) return null
  return {
    actionType: match[1].trim(),
    summary: match[2].trim(),
    details: match[3].trim(),
  }
}
