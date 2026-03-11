"use client"

import React, { useState, useMemo } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism"
import { Copy, Check } from "lucide-react"
import { CitationBadge } from "./CitationBadge"
import type { Citation } from "./types"

// Matches citation patterns like [filename.pdf, p3] or [filename.pdf, section heading]
const CITATION_PATTERN = /\[([^,\]]+\.\w+),\s*([^\]]+)\]/g

function completePartialMarkdown(text: string): string {
  const fenceCount = (text.match(/^```/gm) || []).length
  if (fenceCount % 2 !== 0) return text + "\n```"
  return text
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button onClick={handleCopy} className="p-1 text-gray-400 hover:text-gray-600 transition-colors" aria-label="Copy code">
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}

/**
 * Process a string to replace citation patterns with CitationBadge components.
 * Returns an array of strings and React elements.
 */
function processTextWithCitations(
  text: string,
  citations: Citation[],
  keyPrefix: string
): (string | React.ReactElement)[] {
  const parts: (string | React.ReactElement)[] = []
  let lastIndex = 0

  // Reset regex state
  CITATION_PATTERN.lastIndex = 0
  let match

  while ((match = CITATION_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }

    const filename = match[1].trim()
    const location = match[2].trim()

    // Find matching chunk by filename (case-insensitive)
    const chunk = citations.find(
      (c) => c.source_name.toLowerCase() === filename.toLowerCase()
    )

    parts.push(
      <CitationBadge
        key={`${keyPrefix}-${match.index}`}
        filename={filename}
        location={location}
        chunk={chunk}
      />
    )
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts
}

/**
 * Recursively process React children to find text nodes containing citation patterns.
 */
function processChildren(
  children: React.ReactNode,
  citations: Citation[],
  keyPrefix: string
): React.ReactNode {
  return React.Children.map(children, (child, i) => {
    if (typeof child === "string") {
      const parts = processTextWithCitations(child, citations, `${keyPrefix}-${i}`)
      if (parts.length === 1 && typeof parts[0] === "string") {
        return parts[0]
      }
      return <>{parts}</>
    }
    return child
  })
}

interface MarkdownRendererProps {
  content: string
  citations?: Citation[]
}

export function MarkdownRenderer({ content, citations }: MarkdownRendererProps) {
  if (!content) return null

  const hasCitations = citations && citations.length > 0

  // Build components object — memoized based on citations reference
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const components: Record<string, any> = useMemo(() => {
    const base: Record<string, React.FC<{ className?: string; children?: React.ReactNode }>> = {
      code({ className, children }: { className?: string; children?: React.ReactNode }) {
        const match = /language-(\w+)/.exec(className || "")
        const codeString = String(children).replace(/\n$/, "")
        if (match) {
          return (
            <div className="my-2 rounded-md overflow-hidden border border-gray-300 bg-white">
              <div className="flex items-center justify-between px-3 py-1 bg-gray-100 border-b border-gray-300">
                <span className="text-xs text-gray-500">{match[1]}</span>
                <CopyButton text={codeString} />
              </div>
              <SyntaxHighlighter
                style={oneLight}
                language={match[1]}
                PreTag="div"
                customStyle={{ margin: 0, padding: "0.75rem", fontSize: "0.8rem", background: "white" }}
              >
                {codeString}
              </SyntaxHighlighter>
            </div>
          )
        }
        return <code className="px-1 py-0.5 bg-gray-200/60 rounded text-[0.85em] font-mono">{children}</code>
      },
      pre({ children }: { children?: React.ReactNode }) {
        return <>{children}</>
      },
    }

    // Add citation-aware wrappers for text-containing elements
    if (hasCitations) {
      const wrap = (Tag: string) =>
        function CitationWrapper({ children, ...props }: { children?: React.ReactNode; [key: string]: unknown }) {
          return React.createElement(Tag, props, processChildren(children, citations, Tag))
        }

      base.p = wrap("p")
      base.li = wrap("li")
      base.td = wrap("td")
      base.th = wrap("th")
      base.strong = wrap("strong")
      base.em = wrap("em")
    }

    return base
  }, [hasCitations, citations])

  return (
    <div className="markdown-body leading-relaxed [&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:pl-5 [&_ul]:list-disc [&_ol]:my-1.5 [&_ol]:pl-5 [&_ol]:list-decimal [&_li]:my-0.5 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mt-3 [&_h1]:mb-1.5 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-2.5 [&_h2]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1 [&_blockquote]:border-l-2 [&_blockquote]:border-gray-300 [&_blockquote]:pl-3 [&_blockquote]:my-1.5 [&_blockquote]:text-gray-600 [&_table]:my-2 [&_table]:min-w-full [&_table]:border-collapse [&_table]:text-xs [&_th]:px-2 [&_th]:py-1 [&_th]:bg-gray-100 [&_th]:border [&_th]:border-gray-300 [&_th]:text-left [&_th]:font-medium [&_td]:px-2 [&_td]:py-1 [&_td]:border [&_td]:border-gray-300 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {completePartialMarkdown(content)}
      </ReactMarkdown>
    </div>
  )
}
