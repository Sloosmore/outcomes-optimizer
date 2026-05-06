import { useState, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Resource, ResourceLink } from '@skill-networks/agent-events'
import type { ActiveProcess } from '@/hooks/use-cursor-nodes'
import { AgentDot, MiniSparkline, SectionHeader, Collapsible, AgentList } from '@/components/skill-shared'
import { formatSkillName } from '@/lib/process-status'
import { type SkillConfig, MetricChart } from '@/components/skill-chart-primitives'
import { graphQueryOptions } from '@/lib/graph-query'
import { useProjectUuid } from '@/hooks/use-project'

// ── Panel ────────────────────────────────────────────────────────────────────

interface SkillChildrenPanelProps {
  resource: Resource
  activeProcesses: ActiveProcess[]
  onAgentSelect: (p: ActiveProcess) => void
  onSkillSelect: (id: string) => void
}

export function SkillChildrenPanel({
  resource,
  activeProcesses,
  onAgentSelect,
  onSkillSelect,
}: SkillChildrenPanelProps) {
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(true)
  const config = resource.config as SkillConfig | null
  const projectId = useProjectUuid()

  const queryClient = useQueryClient()
  const cached = queryClient.getQueryData<{ resources: Resource[]; links: ResourceLink[] }>(graphQueryOptions(projectId).queryKey)
  const allSkills = useMemo(() => cached?.resources ?? [], [cached])
  const allLinks = useMemo(() => cached?.links ?? [], [cached])

  const childSkills = useMemo(() => {
    const childIds = new Set(allLinks.filter((l) => l.from_id === resource.id).map((l) => l.to_id))
    return allSkills.filter((r) => childIds.has(r.id))
  }, [allSkills, allLinks, resource.id])

  const relevantSkillIds = useMemo(
    () => new Set([resource.id, ...childSkills.map((c) => c.id)]),
    [resource.id, childSkills],
  )

  const taskCountBySkill = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of activeProcesses) {
      if (p.skill_id && relevantSkillIds.has(p.skill_id)) {
        counts.set(p.skill_id, (counts.get(p.skill_id) ?? 0) + 1)
      }
    }
    return counts
  }, [activeProcesses, relevantSkillIds])

  const scopedProcesses = useMemo(
    () => activeProcesses.filter((p) => p.skill_id && relevantSkillIds.has(p.skill_id)),
    [activeProcesses, relevantSkillIds],
  )

  const hasChart = !!(config?.chart && config.history?.length)

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        {/* High-level chart for the focused skill */}
        <div className="px-2 pt-2 pb-8">
          {hasChart
            ? <MetricChart resource={resource} />
            : config?.current != null
              ? <p className="text-sm font-medium text-muted-foreground">
                  {formatSkillName(resource.name)} — {config.current}{config.unit ? ` ${config.unit}` : ''}
                </p>
              : <p className="text-sm font-medium text-muted-foreground">{formatSkillName(resource.name)}</p>
          }
        </div>

        {/* Child agents — only children, not the focused skill itself */}
        <SectionHeader label="Agents" open={agentsOpen} onToggle={() => setAgentsOpen((v) => !v)} />
        <Collapsible open={agentsOpen}>
          <div className="pb-2">
            {childSkills.map((child) => {
              const taskCount = taskCountBySkill.get(child.id) ?? 0
              const history = (child.config as SkillConfig | null)?.history ?? []
              return (
                <button key={child.id} type="button" onClick={() => onSkillSelect(child.id)}
                  className="w-full flex items-center gap-2 rounded-sm px-2 py-1 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors text-left">
                  <AgentDot processId={child.id} status={taskCount > 0 ? 'active' : 'waiting'} />
                  <span className="min-w-0 flex-1 truncate">{child.name}</span>
                  <MiniSparkline history={history} />
                </button>
              )
            })}
            {childSkills.length === 0 && (
              <p className="px-2 py-2 text-xs text-muted-foreground">No child agents</p>
            )}
          </div>
        </Collapsible>

        {/* Tasks scoped to this subtree */}
        <div className="mt-3">
          <SectionHeader label="Tasks" open={tasksOpen} onToggle={() => setTasksOpen((v) => !v)} />
        </div>
        <Collapsible open={tasksOpen}>
          <div className="pb-1">
            <AgentList processes={scopedProcesses} onSelect={onAgentSelect} />
            {scopedProcesses.length === 0 && (
              <p className="px-2 py-2 text-xs text-muted-foreground">No active tasks</p>
            )}
          </div>
        </Collapsible>
      </div>
    </div>
  )
}
