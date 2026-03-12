import { CheckCircle2, Loader2, Clock, XCircle, ExternalLink, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { WorkflowStep } from "./types"

type WorkflowTrackerProps = {
  steps: WorkflowStep[]
  onApprove?: (stepId: string) => void
  onReject?: (stepId: string) => void
  onRetry?: (stepId: string) => void
}

function StepIcon({ status }: { status: WorkflowStep["status"] }) {
  switch (status) {
    case "complete":
      return <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
    case "in_progress":
      return <Loader2 className="h-5 w-5 text-blue-600 shrink-0 animate-spin" />
    case "pending_approval":
      return <Clock className="h-5 w-5 text-amber-600 shrink-0" />
    case "failed":
      return <XCircle className="h-5 w-5 text-red-600 shrink-0" />
  }
}

const statusBorder: Record<WorkflowStep["status"], string> = {
  complete: "border-green-200 bg-green-50/50",
  in_progress: "border-blue-200 bg-blue-50/50",
  pending_approval: "border-amber-200 bg-amber-50/50",
  failed: "border-red-200 bg-red-50/50",
}

export function WorkflowTracker({ steps, onApprove, onReject, onRetry }: WorkflowTrackerProps) {
  if (steps.length === 0) return null

  return (
    <div className="my-3 space-y-2">
      {steps.map((step) => (
        <div
          key={step.stepId}
          className={`flex items-start gap-3 rounded-lg border p-3 ${statusBorder[step.status]}`}
        >
          <StepIcon status={step.status} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-800">{step.label}</p>

            {step.status === "complete" && step.link && (
              <a
                href={step.link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 mt-1"
              >
                Open <ExternalLink className="h-3 w-3" />
              </a>
            )}

            {step.status === "failed" && step.error && (
              <p className="text-xs text-red-700 mt-1">{step.error}</p>
            )}

            {step.status === "pending_approval" && (onApprove || onReject) && (
              <div className="flex items-center gap-2 mt-2">
                {onApprove && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs border-green-300 text-green-700 hover:bg-green-100"
                    onClick={() => onApprove(step.stepId)}
                  >
                    Approve
                  </Button>
                )}
                {onReject && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs border-red-300 text-red-700 hover:bg-red-100"
                    onClick={() => onReject(step.stepId)}
                  >
                    Reject
                  </Button>
                )}
              </div>
            )}

            {step.status === "failed" && onRetry && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs mt-2 gap-1"
                onClick={() => onRetry(step.stepId)}
              >
                <RefreshCw className="h-3 w-3" />
                Retry
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
