"use client"

import { FormEvent, KeyboardEvent, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Loader2Icon, Mic, MicOff, Send } from "lucide-react"
import { useVoiceInput } from "@/hooks/useVoiceInput"

interface ChatInputProps {
  input: string
  setInput: (input: string) => void
  handleSubmit: (e: FormEvent) => void
  isLoading: boolean
  voiceEnabled?: boolean
  className?: string
}

export function ChatInput({
  input,
  setInput,
  handleSubmit,
  isLoading,
  voiceEnabled = false,
  className = "",
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const {
    voiceState,
    transcript,
    error: voiceError,
    startRecording,
    stopRecording,
    isSupported,
  } = useVoiceInput()

  // Auto-resize the textarea based on content
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = "0px"
      const scrollHeight = textarea.scrollHeight
      textarea.style.height = scrollHeight + "px"
    }
  }, [input])

  // Update input field with live transcript
  useEffect(() => {
    if (transcript) {
      setInput(transcript)
    }
  }, [transcript, setInput])

  // Handle key presses for Ctrl+Enter to add new line and Enter to submit
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter") {
      if (e.ctrlKey) {
        // Add a new line when Ctrl+Enter is pressed
        setInput(`${input}\n\n`)
        e.preventDefault()
      } else if (!e.shiftKey) {
        // Submit the form when Enter is pressed without Shift
        if (input.trim()) {
          e.preventDefault()
          handleSubmit(e as unknown as FormEvent)
        }
      }
    }
  }

  const handleMicClick = async () => {
    if (voiceState === "recording") {
      stopRecording()
    } else {
      await startRecording()
    }
  }

  const isRecording = voiceState === "recording"
  const isTranscribing = voiceState === "transcribing"
  const showMic = voiceEnabled && isSupported

  return (
    <div className={`p-4 w-full ${className}`}>
      {voiceError && (
        <div className="text-sm text-red-600 mb-2 px-1">{voiceError}</div>
      )}
      <form
        onSubmit={handleSubmit}
        className="flex space-x-2 w-full items-end bg-white rounded-lg shadow-lg border border-gray-200 p-3"
      >
        <Textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isRecording
              ? "Listening... click mic to stop"
              : isTranscribing
                ? "Transcribing..."
                : "Type your message... (Ctrl+Enter for new line)"
          }
          disabled={isLoading}
          className="flex-1 min-h-[40px] max-h-[200px] resize-none py-2"
          rows={1}
          autoFocus
        />

        {showMic && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant={isRecording ? "destructive" : "outline"}
                size="icon"
                className={`h-10 w-10 shrink-0 ${isRecording ? "animate-pulse" : ""}`}
                onClick={handleMicClick}
                disabled={isLoading || voiceState === "requesting" || isTranscribing}
              >
                {voiceState === "requesting" ? (
                  <Loader2Icon className="h-4 w-4 animate-spin" />
                ) : isRecording ? (
                  <MicOff className="h-4 w-4" />
                ) : (
                  <Mic className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {isRecording
                ? "Stop recording"
                : "Click to speak — your message will be converted to text"}
            </TooltipContent>
          </Tooltip>
        )}

        <Button type="submit" disabled={!input.trim() || isLoading} className="h-10">
          {isLoading ? (
            <>
              <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
              Thinking...
            </>
          ) : (
            <>
              <Send className="h-4 w-4 mr-2" />
              Send
            </>
          )}
        </Button>
      </form>
    </div>
  )
}
