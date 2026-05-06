import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import { ThemeToggle } from '@/components/theme-toggle'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { apiFetch } from '@/lib/api-fetch'
import { cn } from '@/lib/utils'
import { ORG_STALE_TIME_MS } from '@/constants'
import type { ApiOrgResponse } from '@skill-networks/contracts/org'

type Project = { id: string; name: string; initials?: string }

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
      <DropdownMenuContent align="start" className="min-w-40">
        {projects.map((p) => (
          <DropdownMenuItem
            key={p.id}
            className={cn('text-xs', p.name === currentProject && 'font-medium')}
            onSelect={() => void navigate({ to: '/p/$projectName', params: { projectName: p.name }, replace: true, search: { activeTypes: [], layout: 'tree', 'tree.direction': 'TB', cursors: '1', edges: 'step', orb: '1', arrows: '0', linestyle: 'solid', nodeStyle: 'card', focusType: '' as '' | 'skill' | 'agent', focusId: '' } })}
          >
            {p.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface AppTopBarProps {
  onRightSlot: (el: HTMLElement | null) => void
}

export function AppTopBar({ onRightSlot }: AppTopBarProps) {
  const urlParams = useParams({ strict: false })
  const currentProject = (urlParams as { projectName?: string }).projectName

  const { data } = useQuery<ApiOrgResponse>({
    queryKey: ['org'],
    queryFn: () => apiFetch('/api/org').then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }),
    staleTime: ORG_STALE_TIME_MS,
    placeholderData: (prev) => prev,
  })

  return (
    <div className="h-10 shrink-0 flex items-center justify-between pl-3 pr-4">
      <OrgSwitcher projects={data?.projects ?? []} currentProject={currentProject} />
      <div className="flex items-center gap-1">
        <div ref={onRightSlot} className="flex items-center gap-1" />
        <ThemeToggle />
      </div>
    </div>
  )
}
