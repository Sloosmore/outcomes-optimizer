import '@xyflow/react/dist/style.css'
import { useEffect, useRef, useMemo, useCallback } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  useNodesState,
  type Node,
} from '@xyflow/react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import type { Resource, ResourceLink } from '@skill-networks/agent-events'
import { graphQueryOptions } from '@/lib/graph-query'
import { useProjectUuid } from '@/hooks/use-project'
import * as d3Force from 'd3-force'
import { SkillNode } from '@/components/ui/skill-node'
import { CardNode } from '@/components/ui/card-node'
import { SkillEdge } from '@/components/skill-edge'
import { ForceController } from '@/components/force-controller'
import type { SimNode } from '@/components/force-controller'
import { useCursorNodes } from '@/hooks/use-cursor-nodes'
import { useSkillDrag } from '@/hooks/use-skill-drag'
import { radialLayout } from '@/lib/radial-layout'
import { LAYOUT_REGISTRY, DEFAULT_LAYOUT } from '@/adapters/layout/registry'
import type { LayoutAdapter } from '@/adapters/layout/types'
import { linksToEdges, GraphFocuser } from '@/components/skill-graph-utils'
import { BracketOverlay } from '@/components/bracket-overlay'
import { ContourTerrain } from '@/components/contour-terrain'
import { useCursorFollowState } from '@/hooks/use-cursor-follow'

const nodeTypes = { skillNode: SkillNode, cardNode: CardNode }
const edgeTypes = { skillEdge: SkillEdge }

export function SkillGraph({
  onSkillSelect,
  onCursorClick,
  focusSkillId,
  focusedProcessId,
  adapter = LAYOUT_REGISTRY[DEFAULT_LAYOUT],
  showCursors = true,
  showOrb = true,
  showArrows = false,
  linestyle = 'solid',
  params = new URLSearchParams(),
  maxZoom = 1.5,
}: {
  onSkillSelect?: (id: string) => void
  onCursorClick?: (processId: string) => void
  focusSkillId?: string | null
  focusedProcessId?: string | null
  adapter?: LayoutAdapter
  showCursors?: boolean
  showOrb?: boolean
  showArrows?: boolean
  linestyle?: string
  params?: URLSearchParams
  maxZoom?: number
} = {}) {
  const projectId = useProjectUuid()
  const { data, isPending, isError } = useQuery({ ...graphQueryOptions(projectId), placeholderData: keepPreviousData })

  const resources: Resource[] = useMemo(() => data?.resources ?? [], [data])
  const links: ResourceLink[] = useMemo(() => data?.links ?? [], [data])

  const isTerrain = adapter.id === 'terrain'
  // In terrain mode, show all cursors (don't filter to focused process)
  const { cursorMap } = useCursorNodes(resources, isTerrain ? null : focusedProcessId, links)
  const { followedId, startFollowing, stopFollowing, registerCursorRef, cursorRefsMap, isProgrammaticMove, onViewportMoveStart } = useCursorFollowState()

  const onCursorClickRef = useRef(onCursorClick)
  onCursorClickRef.current = onCursorClick
  const stableOnCursorClick = useCallback((id: string) => onCursorClickRef.current?.(id), [])

  const simNodesRef = useRef<SimNode[]>([])
  const simNodeMapRef = useRef<Map<string, SimNode>>(new Map())
  const simRef = useRef<d3Force.Simulation<SimNode, d3Force.SimulationLinkDatum<SimNode>> | null>(null)
  const restartLoopRef = useRef<(() => void) | null>(null)
  const positionCacheRef = useRef<Map<string, { x: number; y: number }>>(new Map())

  const { onNodeDragStart, onNodeDrag, onNodeDragStop } = useSkillDrag({
    simNodesRef,
    simNodeMapRef,
    simRef,
    restartLoopRef,
  })

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])

  const resourceKey = useMemo(() => resources.map((r) => r.id).join(','), [resources])
  const treeDirection = params.get('tree.direction') ?? 'TB'
  const nodeStyle = params.get('nodeStyle') ?? 'card'
  const edgeStyle = (adapter.id === 'force' || isTerrain) ? 'straight' : (params.get('edges') ?? 'step')

  // Sync sidebar focus → camera follow (terrain mode only).
  // followedId cannot be a pure useMemo derivation because it also has user-driven state
  // (cursor click sets it, pane click clears it). This useEffect syncs an external prop
  // change into the camera-follow system — justified setState-in-effect exception.
  useEffect(() => {
    if (!isTerrain) return
    if (focusedProcessId) {
      startFollowing(focusedProcessId)
    } else {
      stopFollowing()
    }
    // startFollowing/stopFollowing are stable useCallback refs — listing them would not change behavior
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTerrain, focusedProcessId])

  useEffect(() => {
    if (adapter.id !== 'force') return
    for (const node of nodes) {
      positionCacheRef.current.set(node.id, node.position)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes])

  const initialPositions = useMemo(
    () => radialLayout(resources, links),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resourceKey],
  )

  const staticPositions = useMemo(
    () => adapter.computeLayout(resources, links, params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resourceKey, adapter.id, treeDirection, nodeStyle],
  )

  const isStaticLayout = staticPositions !== null

  useEffect(() => {
    if (resources.length === 0) return
    setNodes(
      resources.map((resource) => {
        let position: { x: number; y: number }
        if (isStaticLayout && staticPositions) {
          position = staticPositions.get(resource.id) ?? { x: 0, y: 0 }
        } else {
          const cached = positionCacheRef.current.get(resource.id)
          const computed = initialPositions.get(resource.id)
          position = cached ?? computed ?? { x: 0, y: 0 }
        }
        return {
          id: resource.id,
          type: nodeStyle === 'card' ? 'cardNode' as const : 'skillNode' as const,
          position,
          data: {
            resource,
            cursors: showCursors ? cursorMap.get(resource.id) : undefined,
            onCursorClick: showCursors ? stableOnCursorClick : undefined,
            showOrb,
          },
          draggable: !isStaticLayout,
        }
      }),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceKey, cursorMap, staticPositions, showCursors, showOrb, nodeStyle])

  const visibleLinks = useMemo(
    () => adapter?.filterEdges ? adapter.filterEdges(resources, links) : links,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [links, resources, adapter?.id],
  )
  const allEdges = useMemo(
    () => linksToEdges(visibleLinks, resources, adapter?.reverseEdgeDirection, edgeStyle, showArrows, linestyle, treeDirection, nodeStyle),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleLinks, resources, adapter?.id, edgeStyle, showArrows, linestyle, treeDirection, nodeStyle],
  )

  const isBracket = edgeStyle === 'bracket'
  // Bracket mode draws its own overlay — hide per-edge paths but keep empty edges for React Flow's graph
  const displayEdges = useMemo(() => isBracket ? allEdges.map((e) => ({ ...e, hidden: true })) : allEdges, [allEdges, isBracket])

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => { onSkillSelect?.(node.id) }, [onSkillSelect])

  if (isPending) return (
    <div className="w-full h-full flex items-center justify-center bg-background">
      <p className="text-muted-foreground">Loading skills…</p>
    </div>
  )

  if (isError) return (
    <div className="w-full h-full flex items-center justify-center bg-background">
      <p className="text-destructive">Failed to load skills</p>
    </div>
  )

  return (
    <div className="w-full h-full bg-background relative">
      <ReactFlow
        nodes={nodes}
        edges={isTerrain ? [] : displayEdges}
        className={isTerrain ? 'terrain-mode' : ''}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onNodeDragStart={isStaticLayout ? undefined : onNodeDragStart}
        onNodeDrag={isStaticLayout ? undefined : onNodeDrag}
        onNodeDragStop={isStaticLayout ? undefined : onNodeDragStop}
        onPaneClick={isTerrain ? stopFollowing : undefined}
        onMoveStart={followedId ? undefined : onViewportMoveStart}
        fitView
        fitViewOptions={{ padding: 0.4 }}
        minZoom={0.3}
        maxZoom={maxZoom}
      >
        {!isStaticLayout && (
          <ForceController
            links={links}
            simNodesRef={simNodesRef}
            simNodeMapRef={simNodeMapRef}
            simRef={simRef}
            restartLoopRef={restartLoopRef}
          />
        )}
        <GraphFocuser skillId={focusSkillId ?? null} disabled={isTerrain} />
        {isBracket && (
          <BracketOverlay links={visibleLinks} />
        )}
        {isTerrain && (
          <ContourTerrain
            projectId={projectId ?? ''}
            links={links}
            cursorMap={cursorMap}
            followedId={followedId}
            onFollow={(id: string) => { startFollowing(id); onCursorClick?.(id) }}
            registerRef={registerCursorRef}
            cursorRefsMap={cursorRefsMap}
            isProgrammaticMove={isProgrammaticMove}
          />
        )}
        <Background variant={BackgroundVariant.Dots} className="bg-background" gap={32} size={1} />
      </ReactFlow>
    </div>
  )
}
