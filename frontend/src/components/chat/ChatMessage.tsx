"use client"

import { useState, useMemo } from "react"
import { ThumbsUp, ThumbsDown } from "lucide-react"
import { Message, Citation } from "./types"
import { FeedbackDialog } from "./FeedbackDialog"
import { getToolRenderer } from "@/hooks/useToolRenderer"
import { MarkdownRenderer } from "./MarkdownRenderer"
import { ApprovalCard, parseApprovalRequest } from "./ApprovalCard"
import { WorkflowTracker } from "./WorkflowTracker"
import {
  collectWorkflowEventsFromSegments,
  buildWorkflowSteps,
  stripWorkflowBlocks,
  parseWorkflowEvents,
} from "./workflowParser"

// Matches the formatted output from the KB search Lambda:
// [Source: filename.pdf, relevance: 0.85]\nchunk text\n\n
const KB_RESULT_PATTERN = /\[Source:\s*([^,\]]+),\s*relevance:\s*([\d.]+)\]\n([\s\S]*?)(?=\n\[Source:|$)/g

/**
 * Parse citation data from a KB search tool result string.
 */
function parseCitationsFromToolResult(result: string): Citation[] {
  const citations: Citation[] = []
  KB_RESULT_PATTERN.lastIndex = 0
  let match

  while ((match = KB_RESULT_PATTERN.exec(result)) !== null) {
    citations.push({
      source_name: match[1].trim(),
      text: match[3].trim(),
      relevance_score: parseFloat(match[2]),
    })
  }

  return citations
}

interface ChatMessageProps {
  message: Message
  sessionId: string
  onFeedbackSubmit: (feedbackType: "positive" | "negative", comment: string) => Promise<void>
  onSendMessage?: (message: string) => void
}

export function ChatMessage({ message, sessionId: _sessionId, onFeedbackSubmit, onSendMessage }: ChatMessageProps) {
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [selectedFeedbackType, setSelectedFeedbackType] = useState<"positive" | "negative">(
    "positive"
  )
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false)

  // Extract workflow steps from all text segments
  const workflowSteps = useMemo(() => {
    if (message.role !== "assistant") return []
    const events = message.segments
      ? collectWorkflowEventsFromSegments(message.segments)
      : parseWorkflowEvents(message.content)
    return buildWorkflowSteps(events)
  }, [message.segments, message.content, message.role])

  // Extract citations from search_documents tool results in this message
  const citations = useMemo<Citation[]>(() => {
    if (!message.segments) return []

    const allCitations: Citation[] = []
    for (const seg of message.segments) {
      if (
        seg.type === "tool" &&
        seg.toolCall.name.includes("search_documents") &&
        seg.toolCall.result
      ) {
        allCitations.push(...parseCitationsFromToolResult(seg.toolCall.result))
      }
    }
    return allCitations
  }, [message.segments])

  const formatTime = (timestamp: string) => {
    return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }

  const handleFeedbackClick = (type: "positive" | "negative") => {
    setSelectedFeedbackType(type)
    setIsDialogOpen(true)
  }

  const handleFeedbackSubmit = async (comment: string) => {
    await onFeedbackSubmit(selectedFeedbackType, comment)
    setFeedbackSubmitted(true)
  }

  const renderAssistantContent = () => {
    const tracker = workflowSteps.length > 0 ? (
      <WorkflowTracker
        steps={workflowSteps}
        onApprove={(stepId) => onSendMessage?.(`Approved step: ${stepId}. Go ahead.`)}
        onReject={(stepId) => onSendMessage?.(`Rejected step: ${stepId}. Do not proceed.`)}
        onRetry={(stepId) => onSendMessage?.(`Please retry step: ${stepId}.`)}
      />
    ) : null;

    // If segments exist, render them in order (interleaved text + tools)
    if (message.segments && message.segments.length > 0) {
      let trackerRendered = false;
      const elements = message.segments.map((seg, i) => {
        if (seg.type === "text") {
          // Strip workflow blocks from display text
          let displayText = stripWorkflowBlocks(seg.content);

          // Show tracker before first text segment that had workflow blocks
          const hadWorkflow = displayText !== seg.content;
          let trackerElement = null;
          if (hadWorkflow && !trackerRendered && tracker) {
            trackerRendered = true;
            trackerElement = tracker;
          }

          // Check if this text contains an approval request
          const approval = parseApprovalRequest(displayText);
          if (approval) {
            const afterApproval = displayText.replace(
              /\[APPROVAL_REQUIRED\][\s\S]*?\[\/APPROVAL_REQUIRED\]\s*/,
              ""
            ).trim();
            return (
              <div key={i}>
                {trackerElement}
                <ApprovalCard
                  actionType={approval.actionType}
                  summary={approval.summary}
                  details={approval.details}
                  onApprove={() => onSendMessage?.("Approved. Go ahead.")}
                  onReject={() => onSendMessage?.("Rejected. Do not proceed with this action.")}
                />
                {afterApproval && <MarkdownRenderer content={afterApproval} citations={citations} />}
              </div>
            );
          }

          if (!displayText) {
            return trackerElement ? <div key={i}>{trackerElement}</div> : null;
          }

          return (
            <div key={i}>
              {trackerElement}
              <MarkdownRenderer content={displayText} citations={citations} />
            </div>
          );
        }
        const render = getToolRenderer(seg.toolCall.name);
        if (!render) return null;
        return (
          <div key={seg.toolCall.toolUseId} className="my-1">
            {render({ name: seg.toolCall.name, args: seg.toolCall.input, status: seg.toolCall.status, result: seg.toolCall.result })}
          </div>
        );
      });

      // If tracker hasn't been placed yet (workflow events in later segments), append at end
      if (!trackerRendered && tracker) {
        elements.push(<div key="workflow-tracker">{tracker}</div>);
      }

      return elements;
    }

    // Fallback: plain content
    const displayText = stripWorkflowBlocks(message.content);
    const approval = parseApprovalRequest(displayText);
    if (approval) {
      const afterApproval = displayText.replace(
        /\[APPROVAL_REQUIRED\][\s\S]*?\[\/APPROVAL_REQUIRED\]\s*/,
        ""
      ).trim();
      return (
        <div>
          {tracker}
          <ApprovalCard
            actionType={approval.actionType}
            summary={approval.summary}
            details={approval.details}
            onApprove={() => onSendMessage?.("Approved. Go ahead.")}
            onReject={() => onSendMessage?.("Rejected. Do not proceed with this action.")}
          />
          {afterApproval && <MarkdownRenderer content={afterApproval} citations={citations} />}
        </div>
      );
    }
    return (
      <div>
        {tracker}
        <MarkdownRenderer content={displayText} citations={citations} />
      </div>
    );
  };

  return (
    <div className={`flex flex-col ${message.role === "user" ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[80%] break-words ${
          message.role === "user"
            ? "p-3 rounded-lg bg-gray-800 text-white rounded-br-none whitespace-pre-wrap"
            : "text-gray-800"
        }`}
      >
        {message.role === "assistant" ? renderAssistantContent() : message.content}
      </div>

      {/* Timestamp and Feedback buttons for assistant messages */}
      <div className="flex items-center gap-2 mt-1 px-1">
        <div className="text-xs text-gray-500">{formatTime(message.timestamp)}</div>

        {/* Show feedback buttons only for assistant messages with content */}
        {message.role === "assistant" && message.content && (
          <div className="flex items-center gap-1 ml-2">
            <button
              onClick={() => handleFeedbackClick("positive")}
              disabled={feedbackSubmitted}
              className="p-1 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Positive feedback"
              title="Good response"
            >
              <ThumbsUp size={14} />
            </button>
            <button
              onClick={() => handleFeedbackClick("negative")}
              disabled={feedbackSubmitted}
              className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Negative feedback"
              title="Bad response"
            >
              <ThumbsDown size={14} />
            </button>
            {feedbackSubmitted && (
              <span className="text-xs text-gray-500 ml-1">Thanks for your feedback!</span>
            )}
          </div>
        )}
      </div>

      {/* Feedback Dialog */}
      <FeedbackDialog
        isOpen={isDialogOpen}
        onClose={() => setIsDialogOpen(false)}
        onSubmit={handleFeedbackSubmit}
        feedbackType={selectedFeedbackType}
      />
    </div>
  )
}
