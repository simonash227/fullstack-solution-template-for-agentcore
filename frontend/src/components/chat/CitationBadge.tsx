"use client"

import { useState } from "react"
import { FileText, ChevronDown, ChevronUp } from "lucide-react"

export interface Citation {
  source_name: string
  text: string
  relevance_score: number
}

interface CitationBadgeProps {
  filename: string
  location: string
  chunk?: Citation
}

export function CitationBadge({ filename, location, chunk }: CitationBadgeProps) {
  const [expanded, setExpanded] = useState(false)
  const hasChunk = chunk && chunk.text

  return (
    <>
      <button
        onClick={() => hasChunk && setExpanded(!expanded)}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 text-xs font-medium rounded transition-colors align-baseline ${
          hasChunk
            ? "bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 cursor-pointer"
            : "bg-gray-50 text-gray-600 border border-gray-200 cursor-default"
        }`}
        title={hasChunk ? "Click to view source text" : `${filename}, ${location}`}
      >
        <FileText size={12} className="shrink-0" />
        <span>{filename}, {location}</span>
        {hasChunk && (expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
      </button>
      {expanded && hasChunk && (
        <div className="block mt-1 mb-2 p-3 text-xs bg-gray-50 border border-gray-200 rounded-md text-gray-700 leading-relaxed">
          <div className="font-medium text-gray-500 mb-1 text-[11px]">
            Source: {chunk.source_name} (relevance: {chunk.relevance_score})
          </div>
          <div className="whitespace-pre-wrap">{chunk.text}</div>
        </div>
      )}
    </>
  )
}
