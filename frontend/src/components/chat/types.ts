// Define message types
export type MessageRole = "user" | "assistant"

export type ToolCallStatus = "streaming" | "executing" | "complete"

export interface ToolCall {
  toolUseId: string
  name: string
  input: string
  result?: string
  status: ToolCallStatus
}

export type MessageSegment =
  | { type: "text"; content: string }
  | { type: "tool"; toolCall: ToolCall }

export interface Message {
  role: MessageRole
  content: string
  timestamp: string
  segments?: MessageSegment[]
}

// Citation from Knowledge Base retrieval
export interface Citation {
  source_name: string
  text: string
  relevance_score: number
}

// Workflow tracking types
export type WorkflowStepStatus = "in_progress" | "complete" | "pending_approval" | "failed"

export interface WorkflowStep {
  stepId: string
  label: string
  status: WorkflowStepStatus
  link?: string
  error?: string
  requiresApproval?: boolean
}

export interface WorkflowEvent {
  type: "STEP_START" | "STEP_COMPLETE" | "STEP_PENDING" | "STEP_FAILED"
  stepId: string
  label?: string
  link?: string
  error?: string
  requiresApproval?: boolean
}

// Define chat session types
export interface ChatSession {
  id: string
  name: string
  history: Message[]
  startDate: string
  endDate: string
}
