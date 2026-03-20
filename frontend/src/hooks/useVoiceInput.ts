/**
 * useVoiceInput — hook for browser voice-to-text.
 *
 * Simple "record then transcribe" approach:
 * 1. Records audio via MediaRecorder (WebM/Opus)
 * 2. On stop, sends the audio blob to the Transcribe Lambda
 * 3. Lambda uploads to S3, runs batch transcription, returns text
 * 4. Text populates the input field
 */

import { useState, useRef, useCallback } from "react"
import { useAuth } from "react-oidc-context"

// API base URL loaded from aws-exports.json
let apiBaseUrl = ""

async function getApiBaseUrl(): Promise<string> {
  if (apiBaseUrl) return apiBaseUrl
  const res = await fetch("/aws-exports.json")
  const config = await res.json()
  // feedbackApiUrl ends with "/prod/" — the base for all endpoints
  apiBaseUrl = config.feedbackApiUrl?.replace(/feedback\/?$/, "") || ""
  return apiBaseUrl
}

export type VoiceState = "idle" | "requesting" | "recording" | "transcribing" | "error"

interface UseVoiceInputReturn {
  voiceState: VoiceState
  transcript: string
  error: string | null
  startRecording: () => Promise<void>
  stopRecording: () => void
  isSupported: boolean
}

export function useVoiceInput(): UseVoiceInputReturn {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle")
  const [transcript, setTranscript] = useState("")
  const [error, setError] = useState<string | null>(null)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)

  const auth = useAuth()

  const isSupported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"

  const cleanup = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop()
    }
    mediaRecorderRef.current = null
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    chunksRef.current = []
  }, [])

  const transcribeAudio = useCallback(
    async (audioBlob: Blob) => {
      setVoiceState("transcribing")
      try {
        const baseUrl = await getApiBaseUrl()
        const idToken = auth.user?.id_token
        if (!idToken) throw new Error("Not authenticated")

        // Convert blob to base64
        const arrayBuffer = await audioBlob.arrayBuffer()
        const base64 = btoa(
          new Uint8Array(arrayBuffer).reduce(
            (data, byte) => data + String.fromCharCode(byte),
            ""
          )
        )

        const res = await fetch(`${baseUrl}transcribe/audio`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${idToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            audio: base64,
            format: "webm",
            language_code: "en-AU",
          }),
        })

        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || `Transcription failed: ${res.status}`)
        }

        const data = await res.json()
        if (data.transcript) {
          setTranscript(data.transcript)
        } else if (data.error) {
          throw new Error(data.error)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Transcription failed"
        setError(msg)
        setVoiceState("error")
        return
      }
      setVoiceState("idle")
    },
    [auth.user?.id_token]
  )

  const startRecording = useCallback(async () => {
    setError(null)
    setTranscript("")
    setVoiceState("requesting")
    chunksRef.current = []

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1 },
      })
      streamRef.current = stream

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm",
      })
      mediaRecorderRef.current = mediaRecorder

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data)
        }
      }

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(chunksRef.current, { type: "audio/webm" })
        // Stop mic
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop())
          streamRef.current = null
        }
        // Send for transcription
        if (audioBlob.size > 0) {
          transcribeAudio(audioBlob)
        } else {
          setVoiceState("idle")
        }
      }

      mediaRecorder.start(250) // collect chunks every 250ms
      setVoiceState("recording")
    } catch (err) {
      const msg =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone access denied. Please allow microphone access in your browser settings."
          : err instanceof Error
            ? err.message
            : "Failed to start recording"
      setError(msg)
      setVoiceState("error")
      cleanup()
    }
  }, [cleanup, transcribeAudio])

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop() // triggers onstop → transcribeAudio
    }
  }, [])

  return {
    voiceState,
    transcript,
    error,
    startRecording,
    stopRecording,
    isSupported,
  }
}
