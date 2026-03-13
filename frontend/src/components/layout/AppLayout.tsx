import { useEffect, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { MessageSquare, FileText, BookOpen, Clock, Settings, LogOut, type LucideIcon } from "lucide-react"
import { useAuth } from "@/hooks/useAuth"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { ConversationList } from "@/components/chat/ConversationList"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"

type NavItem = {
  label: string
  icon: LucideIcon
  path: string
}

const navItems: NavItem[] = [
  { label: "Chat", icon: MessageSquare, path: "/" },
  { label: "Documents", icon: FileText, path: "/documents" },
  { label: "What I Know", icon: BookOpen, path: "/knowledge" },
  { label: "History", icon: Clock, path: "/history" },
  { label: "Admin", icon: Settings, path: "/admin" },
]

type Branding = {
  primaryColour?: string
  logoUrl?: string | null
  firmName?: string
  agentName?: string
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, signOut } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [branding, setBranding] = useState<Branding>({})
  const [adminEnabled, setAdminEnabled] = useState(false)

  useEffect(() => {
    fetch("/aws-exports.json")
      .then((r) => r.json())
      .then((config) => {
        if (config.branding) setBranding(config.branding)
        if (config.adminEnabled) setAdminEnabled(true)
      })
      .catch(() => {})
  }, [])

  return (
    <SidebarProvider defaultOpen={true}>
      <Sidebar collapsible="icon">
        <SidebarHeader className="p-4">
          <div className="flex items-center gap-3 overflow-hidden">
            {branding.logoUrl && (
              <img
                src={branding.logoUrl}
                alt={branding.firmName || "Logo"}
                className="h-8 w-8 shrink-0 rounded object-contain"
              />
            )}
            <div className="flex flex-col truncate">
              <span className="text-sm font-semibold truncate">
                {branding.agentName || "AgentCore"}
              </span>
              {branding.firmName && (
                <span className="text-xs text-muted-foreground truncate">
                  {branding.firmName}
                </span>
              )}
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems
                  .filter((item) => item.path !== "/admin" || adminEnabled)
                  .map((item) => (
                  <SidebarMenuItem key={item.path}>
                    <SidebarMenuButton
                      isActive={location.pathname === item.path}
                      onClick={() => navigate(item.path)}
                      tooltip={item.label}
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarSeparator />

          <SidebarGroup>
            <SidebarGroupLabel>Conversations</SidebarGroupLabel>
            <SidebarGroupContent>
              <ConversationList />
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          {isAuthenticated && (
            <SidebarMenu>
              <SidebarMenuItem>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <SidebarMenuButton tooltip="Logout">
                      <LogOut />
                      <span>Logout</span>
                    </SidebarMenuButton>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Confirm Logout</AlertDialogTitle>
                      <AlertDialogDescription>
                        Are you sure you want to log out? You will need to sign
                        in again to access your account.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => signOut()}>
                        Confirm
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </SidebarMenuItem>
            </SidebarMenu>
          )}
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <span className="text-sm font-medium text-muted-foreground">
            {navItems.find((i) => i.path === location.pathname)?.label || ""}
          </span>
        </header>
        <div className="flex flex-col flex-1 overflow-hidden">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
