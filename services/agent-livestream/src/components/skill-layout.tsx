import { useState, useCallback, useMemo } from 'react'
import { PanelRight } from 'lucide-react'
import { useSuspenseQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useTopBarRightPortal } from '@/components/top-bar-slot'
import { SkillGraph } from '@/components/skill-graph'
import { SkillDetailPanel } from '@/components/skill-detail-panel'
import { FocusOverlay } from '@/components/focus-overlay'
import { AgentDetailPanel } from '@/components/agent-detail-panel'
import { SkillChildrenPanel } from '@/components/skill-children-panel'
import { DisplayOptions } from '@/components/display-options'
import { useCursorNodes } from '@/hooks/use-cursor-nodes'
import { useFocusParam } from '@/hooks/use-focus-param'
import { useProjectUuid } from '@/hooks/use-project'
import { LAYOUT_REGISTRY, DEFAULT_LAYOUT, DEFAULT_SEARCH_PARAMS } from '@/adapters/layout/registry'
import { graphQueryOptions } from '@/lib/graph-query'
import type { Resource } from '@skill-networks/agent-events'
import type { ActiveProcess } from '@/hooks/use-cursor-nodes'

interface SkillLayoutProps {
  layout?: string
  treeDirection?: string
  showCursors?: boolean
  edgeStyle?: string
  showOrb?: boolean
  showArrows?: boolean
  linestyle?: string
  nodeStyle?: string
}

export function SkillLayout({
  layout = DEFAULT_LAYOUT,
  treeDirection = 'TB',
  showCursors = true,
  edgeStyle = 'step',
  showOrb = true,
  showArrows = false,
  linestyle = 'solid',
  nodeStyle = 'card',
}: SkillLayoutProps) {
  const [rightOpen, setRightOpen] = useState(true)
  const navigate = useNavigate()
  const projectId = useProjectUuid()

  const activeAdapter = LAYOUT_REGISTRY[layout] ?? LAYOUT_REGISTRY[DEFAULT_LAYOUT]

  const params = useMemo(
    () => new URLSearchParams({ layout, 'tree.direction': treeDirection, cursors: showCursors ? '1' : '0', edges: edgeStyle, orb: showOrb ? '1' : '0', arrows: showArrows ? '1' : '0', linestyle, nodeStyle }),
    [layout, treeDirection, showCursors, edgeStyle, showOrb, showArrows, linestyle, nodeStyle],
  )

  const setParam = useCallback(
    (key: string, value: string) => {
      // rendered inside p.$projectName/ — cast to bypass route-specific search type inference in useNavigate without from
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (navigate as (opts: any) => void)({ search: (prev: unknown) => ({ ...DEFAULT_SEARCH_PARAMS, activeTypes: [], ...(prev as object), [key]: value }) })
    },
    [navigate],
  )

  const { data } = useSuspenseQuery(graphQueryOptions(projectId))
  const resources: Resource[] = useMemo(() => data.resources, [data])
  const links = useMemo(() => data.links, [data])
  const { activeProcesses } = useCursorNodes(resources, undefined, links)

  const { focusedItem, setSkillFocus, setAgentFocus, clearFocus } = useFocusParam(resources, activeProcesses)

  const onAgentSelect = useCallback((process: ActiveProcess) => setAgentFocus(process.process_id), [setAgentFocus])

  const focusSkillId = focusedItem?.type === 'agent'
    ? focusedItem.process.skill_id
    : focusedItem?.type === 'skill'
      ? focusedItem.resource.id
      : null

  const focusedProcessId = focusedItem?.type === 'agent' ? focusedItem.process.process_id : null

  const topBarRight = useTopBarRightPortal(
    <>
      {focusedItem && (
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-7 w-7', rightOpen ? 'text-foreground' : 'text-muted-foreground')}
          onClick={() => setRightOpen((v) => !v)}
        >
          <PanelRight className="h-4 w-4" />
        </Button>
      )}
      <DisplayOptions activeAdapter={activeAdapter} params={params} setParam={setParam} />
    </>,
  )

  const overlayTitle = focusedItem?.type === 'agent'
    ? focusedItem.process.process_name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    : focusedItem?.type === 'skill'
      ? focusedItem.resource.name
      : null

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {topBarRight}
      {/* Content */}
      <div className="flex-1 flex overflow-hidden relative">

        {/* Inner left panel — agents + tasks */}
        <div className="shrink-0 w-64 border-r overflow-y-auto px-2">
          <SkillDetailPanel
            activeProcesses={activeProcesses}
            onAgentSelect={onAgentSelect}
            onSkillSelect={setSkillFocus}
          />
        </div>

        {/* Graph */}
        <div className="flex-1 overflow-hidden relative">
          <SkillGraph
            onSkillSelect={setSkillFocus}
            onCursorClick={setAgentFocus}
            focusSkillId={focusSkillId}
            focusedProcessId={focusedProcessId}
            adapter={activeAdapter}
            showCursors={showCursors}
            showOrb={showOrb}
            showArrows={showArrows}
            linestyle={linestyle}
            params={params}
            maxZoom={2}
          />
          {focusedItem && overlayTitle && (
            <FocusOverlay title={overlayTitle} onDismiss={clearFocus} rightOffset={rightOpen && focusedItem ? 256 : 0} />
          )}
        </div>

        {/* Right detail panel — overlays the graph instead of squishing it */}
        <div className={cn(
          'absolute right-0 top-0 h-full z-20 overflow-hidden transition-all duration-300 bg-background',
          rightOpen && focusedItem ? 'w-64 border-l' : 'w-0',
        )}>
          <div className="w-64 h-full flex flex-col">
            {focusedItem?.type === 'agent' && (
              <AgentDetailPanel process={focusedItem.process} />
            )}
            {focusedItem?.type === 'skill' && (
              <div className="px-2 pt-2 h-full overflow-hidden">
                <SkillChildrenPanel resource={focusedItem.resource} activeProcesses={activeProcesses} onAgentSelect={onAgentSelect} onSkillSelect={setSkillFocus} />
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  )
}
