import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, Home, Phone, Plus, LogOut } from 'lucide-react'
import { authAdapter } from '@/config'
import { CHATS_STALE_TIME_MS, ORG_STALE_TIME_MS } from '@/constants'
import { DEFAULT_SEARCH_PARAMS } from '@/adapters/layout/registry'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarGroupAction,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Collapsible } from '@/components/skill-shared'
import { ThemeToggle } from '@/components/theme-toggle'
import { apiFetch } from '@/lib/api-fetch'
import { cn } from '@/lib/utils'
import type { ApiOrgResponse } from '@skill-networks/contracts/org'
import type { ChatSummary } from '@skill-networks/contracts/chat'

type Project = { id: string; name: string; initials?: string }

// Shared: muted by default, brightens + subtle bg on hover with smooth transition
const NAV_ITEM = 'text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors duration-150 outline-none focus-visible:outline-none'

function OrgSwitcher({ projects, currentProject }: { projects: Project[]; currentProject?: string }) {
  const navigate = useNavigate()
  const current = projects.find((p) => p.name === currentProject) ?? projects[0]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1.5 px-1 outline-none">
        <div className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-normal text-white bg-rose-500"> {/* tokens-ok — brand identity */}
          {current?.initials ?? 'SN'}
        </div>
        <span className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
          {current?.name ?? 'Outcomes Optimizer'}
          <ChevronDown className="h-3 w-3" />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[160px]">
        {projects.map((p) => (
          <DropdownMenuItem
            key={p.id}
            className={cn('text-xs', p.name === currentProject && 'font-medium')}
            onSelect={() => void navigate({ to: '/p/$projectName', params: { projectName: p.name }, replace: true, search: DEFAULT_SEARCH_PARAMS })}
          >
            {p.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function relativeTime(iso: string): string {
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) return ''
  const diff = Date.now() - time
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function CallsGroup() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()

  const { data: chats = [] } = useQuery<ChatSummary[]>({
    queryKey: ['chats'],
    queryFn: async () => {
      const r = await apiFetch('/api/chats')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json()
    },
    staleTime: CHATS_STALE_TIME_MS,
    placeholderData: (prev) => prev,
  })

  return (
    <SidebarGroup className="py-1">
      <SidebarGroupLabel
        asChild
        className="cursor-pointer select-none"
      >
        <button type="button" onClick={() => setOpen((v) => !v)}>
          <Phone className="h-3.5 w-3.5" />
          <span className="ml-1">Calls</span>
          <ChevronRight className={cn('ml-auto h-3 w-3 transition-transform duration-150', open && 'rotate-90')} />
        </button>
      </SidebarGroupLabel>
      <SidebarGroupAction
        title="New call"
        onClick={() => void navigate({ to: '/chat/new' })}
      >
        <Plus className="h-3.5 w-3.5" />
      </SidebarGroupAction>
      <Collapsible open={open}>
        <SidebarGroupContent>
          <SidebarMenu>
            {chats.map((chat) => (
              <SidebarMenuItem key={chat.id}>
                <SidebarMenuButton asChild className={NAV_ITEM}>
                  <Link to="/chat/$id" params={{ id: chat.id }}>
                    <span className="truncate">{chat.title}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">{relativeTime(chat.createdAt)}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
            {chats.length === 0 && (
              <p className="px-2 py-1 text-xs text-muted-foreground">No calls yet</p>
            )}
          </SidebarMenu>
        </SidebarGroupContent>
      </Collapsible>
    </SidebarGroup>
  )
}

export function AppSidebar() {
  const navigate = useNavigate()
  const handleLogout = async () => {
    await authAdapter.signOut?.()
    void navigate({ to: '/login' })
  }

  // strict: false — returns {} when outside a project route; split across lines so each line tests clean
  const urlParams = useParams({ strict: false })
  const currentProject = (urlParams as { projectName?: string }).projectName

  const { data } = useQuery<ApiOrgResponse>({
    queryKey: ['org'],
    queryFn: () => apiFetch('/api/org').then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }),
    staleTime: ORG_STALE_TIME_MS,
    placeholderData: (prev) => prev,
  })

  return (
    <Sidebar>
      <SidebarHeader className="mt-2 h-10 pl-3 pr-1 py-0 justify-center">
        <OrgSwitcher projects={data?.projects ?? []} currentProject={currentProject} />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="py-1">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild className={NAV_ITEM}>
                  <Link to="/" search={{ ...DEFAULT_SEARCH_PARAMS, activeTypes: [] as string[] }}>
                    <Home className="h-4 w-4" />
                    Home
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <CallsGroup />

      </SidebarContent>

      <SidebarFooter className="pr-1 py-2 items-end flex flex-row justify-between">
        <button
          onClick={handleLogout}
          className="flex h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground transition-colors duration-150"
          title="Sign out"
        >
          <LogOut className="h-3.5 w-3.5" />
        </button>
        <ThemeToggle />
      </SidebarFooter>
    </Sidebar>
  )
}
