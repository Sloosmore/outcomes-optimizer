import { useState, useMemo } from 'react'
import { useQueryClient, useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import type { Resource, ResourceLink } from '@skill-networks/agent-events'
import type { ActiveProcess } from '@/hooks/use-cursor-nodes'
import type { ApiProcess } from '@skill-networks/contracts/processes'
import { cn } from '@/lib/utils'
import { AgentDot, MiniSparkline, SectionHeader, Collapsible, AgentList, RecentTaskList } from '@/components/skill-shared'
import { ScrollArea } from '@/components/ui/scroll-area'
import { apiFetch } from '@/lib/api-fetch'
import { graphQueryOptions } from '@/lib/graph-query'
import { useProjectId, useProjectUuid } from '@/hooks/use-project'
import { SIX_HOURS_MS } from '@/constants' 

type SkillConfig = { size?: string; history?: { date: string; value: number }[] }

const EMPTY_RECENT: ApiProcess[] = []

interface SkillDetailPanelProps {
  activeProcesses: ActiveProcess[]
  onAgentSelect: (p: ActiveProcess) => void
  onSkillSelect: (id: string) => void
}

export function SkillDetailPanel({ activeProcesses, onAgentSelect, onSkillSelect }: SkillDetailPanelProps) {
  const [agentsOpen, setAgentsOpen] = useState(true)
  const [tasksOpen, setTasksOpen] = useState(true)
  const [recentOpen, setRecentOpen] = useState(false)
  const projectName = useProjectId()
  const projectUuid = useProjectUuid()

  // Stable mount-time cutoff — fixed when the component mounts (lazy useState, pure)
  const [since6h] = useState(() => new Date(Date.now() - SIX_HOURS_MS).toISOString())
  const [cutoffMs] = useState(() => Date.now() - SIX_HOURS_MS)
  const { data: recentRaw = EMPTY_RECENT } = useQuery<ApiProcess[]>({
    queryKey: ['processes', 'recent', since6h, projectName],
    queryFn: async () => { return apiFetch(`/api/processes?since=${encodeURIComponent(since6h)}&project=${encodeURIComponent(projectName)}`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }) },
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  })
  const recentFinished = useMemo(
    () => recentRaw.filter((p) => {
      if (p.status !== 'completed' && p.status !== 'failed') return false
      const finishedAt = p.completed_at ?? p.updated_at
      if (!finishedAt) return false
      return new Date(finishedAt).getTime() >= cutoffMs
    }),
    [recentRaw, cutoffMs],
  )

  const queryClient = useQueryClient()
  const cached = queryClient.getQueryData<{ resources: Resource[]; links: ResourceLink[] }>(graphQueryOptions(projectUuid).queryKey)
  const allSkills = useMemo(() => cached?.resources ?? [], [cached])
  const allLinks = useMemo(() => cached?.links ?? [], [cached])

  const parentSkills = useMemo(() => allSkills.filter((r) => r.type === 'agent' || (r.config as { size?: string } | null)?.size === 'xl'), [allSkills])
  const childrenByParent = useMemo(() => {
    const map = new Map<string, Resource[]>()
    for (const link of allLinks) {
      const child = allSkills.find((r) => r.id === link.to_id && r.type !== 'agent' && (r.config as { size?: string } | null)?.size === 'lg')
      if (!child) continue
      const kids = map.get(link.from_id) ?? []
      kids.push(child)
      map.set(link.from_id, kids)
    }
    return map
  }, [allSkills, allLinks])

  const taskCountBySkill = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of activeProcesses) {
      if (p.skill_id) counts.set(p.skill_id, (counts.get(p.skill_id) ?? 0) + 1)
    }
    return counts
  }, [activeProcesses])

  return (
    <div className="flex flex-col h-full overflow-hidden pt-2">
      <SectionHeader label="Agents" open={agentsOpen} onToggle={() => setAgentsOpen((v) => !v)} />
      <Collapsible open={agentsOpen}>
        <div className="pb-2">
          {parentSkills.map((parent) => (
            <div key={parent.id}>
              <button type="button" onClick={() => onSkillSelect(parent.id)}
                className="w-full flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm font-medium text-muted-foreground/70 hover:text-foreground hover:bg-muted/40 transition-colors text-left">
                <AgentDot processId={parent.id} status={(taskCountBySkill.get(parent.id) ?? 0) > 0 ? 'active' : 'waiting'} />
                <span className="min-w-0 flex-1 truncate">{parent.name}</span>
                <MiniSparkline history={(parent.config as SkillConfig | null)?.history ?? []} />
              </button>
              {(childrenByParent.get(parent.id) ?? []).map((child) => {
                const taskCount = taskCountBySkill.get(child.id) ?? 0
                return (
                  <button key={child.id} type="button" onClick={() => onSkillSelect(child.id)}
                    className="w-full flex items-center gap-2 rounded-sm px-2 py-1 text-sm font-medium text-muted-foreground/70 hover:text-foreground hover:bg-muted/40 transition-colors text-left">
                    <AgentDot processId={child.id} status={taskCount > 0 ? 'active' : 'waiting'} />
                    <span className="min-w-0 flex-1 truncate">{child.name}</span>
                    <MiniSparkline history={(child.config as SkillConfig | null)?.history ?? []} />
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </Collapsible>
      <div className="mt-4">
        <SectionHeader label="Tasks" open={tasksOpen} onToggle={() => setTasksOpen((v) => !v)} />
      </div>
      <Collapsible open={tasksOpen}>
        <div className="pb-1">
          <AgentList processes={activeProcesses} onSelect={onAgentSelect} />
          {recentFinished.length > 0 && (
            <>
              <button type="button" onClick={() => setRecentOpen((v) => !v)}
                className="w-full flex items-center gap-1 px-2 pt-8 pb-1.5 text-xs text-muted-foreground/40 hover:text-muted-foreground/60 transition-colors">
                <span>Recently completed</span>
                <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform duration-150', recentOpen && 'rotate-90')} />
              </button>
              <Collapsible open={recentOpen}>
                <ScrollArea className="h-48">
                  <RecentTaskList processes={recentFinished} />
                </ScrollArea>
              </Collapsible>
            </>
          )}
        </div>
      </Collapsible>
    </div>
  )
}
