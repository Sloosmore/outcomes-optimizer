import { useState, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Resource, ResourceLink } from '@skill-networks/agent-events'
import type { ActiveProcess } from '@/hooks/use-cursor-nodes'
import { ProgressRing, SectionHeader, Collapsible, AgentList } from '@/components/skill-shared'
import { formatSkillName, deriveProgressValue } from '@/lib/process-status'
import { type SkillConfig, MetricChart } from '@/components/skill-chart-primitives'
import { graphQueryOptions } from '@/lib/graph-query'
import { useProjectUuid } from '@/hooks/use-project'

function hasChartData(r: Resource): boolean {
  const c = r.config as SkillConfig | null
  return !!(c?.chart && c.history && c.history.length > 0)
}

interface SkillChartsPanelProps {
  resource: Resource
  activeProcesses: ActiveProcess[]
  onAgentSelect: (p: ActiveProcess) => void
  onSkillSelect?: (id: string) => void
}

export function SkillChartsPanel({ resource, activeProcesses, onAgentSelect, onSkillSelect }: SkillChartsPanelProps) {
  const config = resource.config as SkillConfig | null
  const [objectiveOpen, setObjectiveOpen] = useState(true)
  const [agentsOpen, setAgentsOpen] = useState(true)
  const [keyResultsOpen, setKeyResultsOpen] = useState(true)
  const projectId = useProjectUuid()

  const queryClient = useQueryClient()
  const cached = queryClient.getQueryData<{ resources: Resource[]; links: ResourceLink[] }>(graphQueryOptions(projectId).queryKey)
  const allResources = useMemo(() => cached?.resources ?? [], [cached])
  const allLinks = useMemo(() => cached?.links ?? [], [cached])

  const children = useMemo(() => {
    const childIds = allLinks.filter((l) => l.from_id === resource.id).map((l) => l.to_id)
    return allResources.filter((r) => childIds.includes(r.id))
  }, [allLinks, allResources, resource.id])

  const withData = children.filter(hasChartData)
  const withoutData = children.filter((c) => !hasChartData(c))

  const parentChartResource = (() => {
    if (!config?.current || config.history?.length) return null
    const today = new Date()
    const current = config.current
    const history = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (5 - i))
      return { date: d.toISOString().slice(0, 10), value: current }
    })
    return { ...resource, config: { ...config, history, chart: config.chart ?? { type: 'area', height: 64 } } } as Resource
  })()

  const parentDisplay = hasChartData(resource)
    ? <MetricChart resource={resource} />
    : parentChartResource
      ? <MetricChart resource={parentChartResource} />
      : config?.current != null
        ? <p className="text-sm font-medium text-muted-foreground">
            {formatSkillName(resource.name)} — {config.current}{config.unit ? ` ${config.unit}` : ''}
          </p>
        : <p className="text-sm font-medium text-muted-foreground">{formatSkillName(resource.name)}</p>

  const isLeaf = children.length === 0

  const relevantProcesses = useMemo(() => {
    const ids = new Set([resource.id, ...children.map((c) => c.id)])
    return activeProcesses.filter((p) => p.skill_id !== null && ids.has(p.skill_id))
  }, [resource.id, children, activeProcesses])

  const agentsSection = (
    <>
      <SectionHeader label="Tasks" open={agentsOpen} onToggle={() => setAgentsOpen((v) => !v)} />
      <Collapsible open={agentsOpen}>
        <div className="pb-1"><AgentList processes={relevantProcesses} onSelect={onAgentSelect} /></div>
      </Collapsible>
    </>
  )

  if (isLeaf) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          <div className="px-4 pt-4 pb-4">
            {hasChartData(resource) ? <MetricChart resource={resource} /> : parentDisplay}
          </div>
          {!hasChartData(resource) && config?.current == null && (
            <div className="px-4 pb-4"><p className="text-xs text-muted-foreground/50">No data yet</p></div>
          )}
          {agentsSection}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto pt-2">
        <SectionHeader label="Objective" open={objectiveOpen} onToggle={() => setObjectiveOpen((v) => !v)} />
        <Collapsible open={objectiveOpen}>
          <div className="px-4 pb-4">{parentDisplay}</div>
        </Collapsible>

        <div className="mt-4">{agentsSection}</div>

        <div className="mt-4">
          <SectionHeader label="Key Results" open={keyResultsOpen} onToggle={() => setKeyResultsOpen((v) => !v)} />
        </div>
        <Collapsible open={keyResultsOpen}>
          <div className="pb-2">
            {children.length === 0 && (
              <p className="px-4 py-1.5 text-xs text-muted-foreground/50">No key results</p>
            )}
            {withData.map((child) => {
              const childConfig = child.config as SkillConfig | null
              const ringValue = deriveProgressValue(childConfig)
              const valueLabel = childConfig?.current != null
                ? `${childConfig.current}${childConfig.unit ? ` ${childConfig.unit}` : ''}` : null
              return (
                <button key={child.id} type="button" onClick={() => onSkillSelect?.(child.id)}
                  className="w-full flex items-center gap-2 rounded-sm px-4 py-1 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors text-left">
                  <ProgressRing value={ringValue} />
                  <span className="min-w-0 flex-1 truncate">{formatSkillName(child.name)}</span>
                  {valueLabel && <span className="shrink-0 text-xs font-mono text-muted-foreground/60">{valueLabel}</span>}
                </button>
              )
            })}
            {withoutData.map((child) => (
              <button key={child.id} type="button" onClick={() => onSkillSelect?.(child.id)}
                className="w-full flex items-center gap-2 rounded-sm px-4 py-1 text-sm text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/40 transition-colors text-left">
                <ProgressRing value={null} />
                <span className="min-w-0 flex-1 truncate">{formatSkillName(child.name)}</span>
              </button>
            ))}
          </div>
        </Collapsible>
      </div>
    </div>
  )
}
