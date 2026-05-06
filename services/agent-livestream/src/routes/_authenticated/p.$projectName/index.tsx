import { Suspense } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { SkillLayout } from '@/components/skill-layout'
import { DashboardSkeleton } from '@/components/dashboard-skeleton'
import { LAYOUT_REGISTRY, DEFAULT_LAYOUT } from '@/adapters/layout/registry'
import { graphQueryOptions } from '@/lib/graph-query'

export const Route = createFileRoute('/_authenticated/p/$projectName/')({
  loader: ({ context, params }) => {
    const project = context.orgData?.projects.find((p) => p.name === params.projectName)
    if (project) void context.queryClient.prefetchQuery(graphQueryOptions(project.id))
  },
  validateSearch: (search: Record<string, unknown>) => ({
    activeTypes: Array.isArray(search.activeTypes) ? search.activeTypes.filter((v): v is string => typeof v === 'string') : [],
    layout: typeof search.layout === 'string' && search.layout in LAYOUT_REGISTRY ? search.layout : DEFAULT_LAYOUT,
    'tree.direction': search['tree.direction'] === 'LR' ? 'LR' : 'TB',
    cursors: typeof search.cursors === 'string' ? search.cursors : '1',
    edges: search.edges === 'straight' ? 'straight' : search.edges === 'bracket' ? 'bracket' : 'step',
    orb: search.orb === '0' ? '0' : '1',
    arrows: search.arrows === '1' ? '1' : '0',
    linestyle: search.linestyle === 'dashed' ? 'dashed' : 'solid',
    nodeStyle: search.nodeStyle === 'orb' ? 'orb' : 'card',
    focusType: search.focusType === 'skill' || search.focusType === 'agent' || search.focusType === '' ? search.focusType : '' as 'skill' | 'agent' | '',
    focusId: typeof search.focusId === 'string' && search.focusId.length < 256 ? search.focusId : '',
  }),
  component: function IndexRoute() {
    const { layout, 'tree.direction': treeDirection, cursors, edges, orb, arrows, linestyle, nodeStyle } = Route.useSearch()
    return (
      <Suspense fallback={<DashboardSkeleton />}>
        <SkillLayout
          layout={layout}
          treeDirection={treeDirection}
          showCursors={cursors !== '0'}
          edgeStyle={edges}
          showOrb={orb !== '0'}
          showArrows={arrows !== '0'}
          linestyle={linestyle}
          nodeStyle={nodeStyle}
        />
      </Suspense>
    )
  },
})
