"use client"
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react"
import ChatInterface from "@/components/chat/ChatInterface"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/hooks/useAuth"
import { GlobalContextProvider } from "@/app/context/GlobalContext"

export default function ChatPage() {
  const { isAuthenticated, signIn } = useAuth()
  const [firmName, setFirmName] = useState<string>("")

  useEffect(() => {
    fetch("/aws-exports.json")
      .then((r) => r.json())
      .then((config) => {
        if (config.branding?.firmName) {
          setFirmName(config.branding.firmName)
        }
      })
      .catch(() => {})
  }, [])

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        {firmName && <p className="text-lg text-gray-500">{firmName}</p>}
        <p className="text-4xl font-bold">Please sign in</p>
        <Button onClick={() => signIn()}>Sign In</Button>
      </div>
    )
  }

  return (
    <GlobalContextProvider>
      <div className="relative h-screen">
        <ChatInterface />
      </div>
    </GlobalContextProvider>
  )
}
