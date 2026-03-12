import { WorkflowEvent, WorkflowStep } from "./types"

const WORKFLOW_BLOCK_PATTERN = /\[WORKFLOW\]([\s\S]*?)\[\/WORKFLOW\]/g

/**
 * Extract all [WORKFLOW]...[/WORKFLOW] JSON blocks from text content.
 */
export function parseWorkflowEvents(text: string): WorkflowEvent[] {
  const events: WorkflowEvent[] = []
  WORKFLOW_BLOCK_PATTERN.lastIndex = 0
  let match

  while ((match = WORKFLOW_BLOCK_PATTERN.exec(text)) !== null) {
    try {
      const event = JSON.parse(match[1].trim()) as WorkflowEvent
      if (event.type && event.stepId) {
        events.push(event)
      }
    } catch {
      // Skip malformed blocks
    }
  }

  return events
}

/**
 * Strip [WORKFLOW] blocks from text, returning clean content for display.
 */
export function stripWorkflowBlocks(text: string): string {
  return text.replace(WORKFLOW_BLOCK_PATTERN, "").trim()
}

/**
 * Build step state from a list of workflow events.
 * Later events override earlier ones for the same stepId.
 */
export function buildWorkflowSteps(events: WorkflowEvent[]): WorkflowStep[] {
  const stepMap = new Map<string, WorkflowStep>()
  const order: string[] = []

  for (const event of events) {
    if (!stepMap.has(event.stepId)) {
      order.push(event.stepId)
    }

    const existing = stepMap.get(event.stepId)

    switch (event.type) {
      case "STEP_START":
        stepMap.set(event.stepId, {
          stepId: event.stepId,
          label: event.label || existing?.label || event.stepId,
          status: "in_progress",
        })
        break
      case "STEP_COMPLETE":
        stepMap.set(event.stepId, {
          stepId: event.stepId,
          label: existing?.label || event.label || event.stepId,
          status: "complete",
          link: event.link,
        })
        break
      case "STEP_PENDING":
        stepMap.set(event.stepId, {
          stepId: event.stepId,
          label: event.label || existing?.label || event.stepId,
          status: "pending_approval",
          requiresApproval: event.requiresApproval,
        })
        break
      case "STEP_FAILED":
        stepMap.set(event.stepId, {
          stepId: event.stepId,
          label: existing?.label || event.label || event.stepId,
          status: "failed",
          error: event.error,
        })
        break
    }
  }

  return order.map((id) => stepMap.get(id)!)
}

/**
 * Collect all workflow events from all text segments in a message.
 */
export function collectWorkflowEventsFromSegments(
  segments: Array<{ type: string; content?: string }>
): WorkflowEvent[] {
  const events: WorkflowEvent[] = []
  for (const seg of segments) {
    if (seg.type === "text" && seg.content) {
      events.push(...parseWorkflowEvents(seg.content))
    }
  }
  return events
}
