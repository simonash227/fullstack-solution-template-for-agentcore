// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Routes, Route } from 'react-router-dom'
import ChatPage from './ChatPage'
import DocumentsPage from './DocumentsPage'

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<ChatPage />} />
      <Route path="/documents" element={<DocumentsPage />} />
    </Routes>
  )
}
