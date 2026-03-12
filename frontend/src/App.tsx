import { BrowserRouter } from "react-router-dom"
import { AuthProvider } from "@/components/auth/AuthProvider"
import { GlobalContextProvider } from "@/app/context/GlobalContext"
import { ChatContextProvider } from "@/app/context/ChatContext"
import AppLayout from "@/components/layout/AppLayout"
import AppRoutes from "./routes"

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <GlobalContextProvider>
          <ChatContextProvider>
            <AppLayout>
              <AppRoutes />
            </AppLayout>
          </ChatContextProvider>
        </GlobalContextProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
