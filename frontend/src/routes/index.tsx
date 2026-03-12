import { Routes, Route } from "react-router-dom"
import ChatPage from "./ChatPage"
import DocumentsPage from "./DocumentsPage"
import HistoryPage from "./HistoryPage"
import AdminPage from "./AdminPage"
import KnowledgePage from "./KnowledgePage"

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<ChatPage />} />
      <Route path="/documents" element={<DocumentsPage />} />
      <Route path="/knowledge" element={<KnowledgePage />} />
      <Route path="/history" element={<HistoryPage />} />
      <Route path="/admin" element={<AdminPage />} />
    </Routes>
  )
}
