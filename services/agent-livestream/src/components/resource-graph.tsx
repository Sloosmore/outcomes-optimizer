import '@xyflow/react/dist/style.css'
import { useEffect, useRef, useMemo, useCallback, useState } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from '@xyflow/react'
import { useQuery } from '@tanstack/react-query'
import type { Resource, ResourceLink } from '@skill-networks/agent-events'
import * as d3Force from 'd3-force'
import { graphAdapter, supabaseClient } from '@/config'
import type { AskUserQuestion } from '@/components/ask-user-panel'
import { ResourceNode } from '@/components/ui/resource-node'
import { UserNode } from '@/components/ui/user-node'
import { AgentCursorNode } from '@/components/agent-cursor'
import { useCursors } from '@/hooks/use-cursors'
import type { CursorPosition } from '@/hooks/use-cursors'
import type { CursorNodeData } from '@/components/agent-cursor'
import { GraphFilter } from '@/components/graph-filter'
import { ForceController, linksToEdges } from '@/components/resource-graph-force'
import type { SimNode, SimRef } from '@/components/resource-graph-force'

const nodeTypes = {
  resourceNode: ResourceNode,
  cursorNode: AgentCursorNode,
  userNode: UserNode,
}

/**
 * Demo / screenshot toggle for the `ask_user` tool UI. Passing
 * `?askUser=<process_id>` (or comma-separated `?askUser=pid1,pid2`, or
 * repeated `?askUser=pid1&askUser=pid2`) on the URL replaces those cursors'
 * small pill with the multi-question `AskUserPanel`. Optional
 * `?askUserQuestions=q1|q2|q3` overrides the default question set; the same
 * set is used for every overridden cursor. Real wiring (driving this from an
 * `ask_user` agent_event) is a follow-up; the URL toggle is the screenshot
 * path.
 */
const DEFAULT_ASK_USER_QUESTIONS: AskUserQuestion[] = [
  {
    kind: 'select_one',
    text: 'Should I rebuild the Postgres image now?',
    options: ['Yes, rebuild now', 'No, skip for now'],
  },
  {
    kind: 'select_multiple',
    text: 'Which checks should I run before continuing?',
    options: ['Unit tests', 'Schema-drift check', 'Type-check'],
  },
]

function readAskUserOverride(): { processIds: Set<string>; questions: AskUserQuestion[] } | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const raw = params.getAll('askUser')
  if (raw.length === 0) return null
  // Split each value on commas so `?askUser=a,b&askUser=c` and
  // `?askUser=a&askUser=b&askUser=c` both expand to {a, b, c}.
  const processIds = new Set(raw.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean))
  if (processIds.size === 0) return null
  return { processIds, questions: DEFAULT_ASK_USER_QUESTIONS }
}

function cursorNodes(
  cursors: Omit<CursorPosition, 'updatedAt'>[],
  resourceNodes: Node[],
  askUserOverride: { processIds: Set<string>; questions: AskUserQuestion[] } | null,
): Node<CursorNodeData>[] {
  return cursors
    .map((cursor) => {
      const target = resourceNodes.find((n) => n.id === cursor.resource_id)
      if (!target) return null
      const askUser = askUserOverride?.processIds.has(cursor.process_id)
        ? { questions: askUserOverride.questions }
        : undefined
      return {
        id: `cursor-${cursor.process_id}`,
        type: 'cursorNode' as const,
        position: { x: target.position.x - 15, y: target.position.y + 5 },
        data: {
          process_id: cursor.process_id,
          process_name: cursor.process_name,
          resource_id: cursor.resource_id,
          askUser,
        },
        zIndex: 1,
        draggable: false,
        selectable: false,
        connectable: false,
      }
    })
    .filter((n): n is NonNullable<typeof n> => n !== null)
}

export function ResourceGraph() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['neighborhood'],
    queryFn: () => graphAdapter.getNeighborhood([], 2),
  })

  const { data: authUser } = useQuery({
    queryKey: ['auth-user'],
    queryFn: () => supabaseClient.auth.getUser(),
  })
  const currentAuthUuid = authUser?.data?.user?.id ?? null
  const avatarUrl = (authUser?.data?.user?.user_metadata?.avatar_url as string | undefined) ?? null

  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set())
  const toggleType = useCallback((type: string) => {
    setActiveTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) { next.delete(type) } else { next.add(type) }
      return next
    })
  }, [])

  const allResources = useMemo<Resource[]>(() => data?.nodes ?? [], [data?.nodes])
  const resources = useMemo(
    () => activeTypes.size > 0
      ? allResources.filter((r) => activeTypes.has(r.type))
      : allResources,
    [allResources, activeTypes]
  )
  const links = useMemo<ResourceLink[]>(() => data?.edges ?? [], [data?.edges])

  const visibleResources = useMemo(() => {
    const userIdsWithParentLinks = new Set(
      links.filter((l) => l.link_type === 'parent').map((l) => l.from_id)
    )
    return resources.filter(
      (r) => r.type !== 'user' || userIdsWithParentLinks.has(r.id)
    )
  }, [links, resources])

  const cursors = useCursors()

  const simNodesRef = useRef<SimNode[]>([])
  const simRef = useRef<d3Force.Simulation<SimNode, d3Force.SimulationLinkDatum<SimNode>> | null>(null)

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [, , onEdgesChange] = useEdgesState<Edge>([])

  useEffect(() => {
    if (visibleResources.length === 0) return
    setNodes(
      visibleResources.map((resource) => ({
        id: resource.id,
        type: resource.type === 'user' ? 'userNode' as const : 'resourceNode' as const,
        position: {
          x: (Math.random() - 0.5) * 1200,
          y: (Math.random() - 0.5) * 1200,
        },
        data: resource.type === 'user'
          ? {
              resource,
              currentAuthUuid,
              avatarUrl: resource.name === `user:${currentAuthUuid}` ? avatarUrl : null,
            }
          : { resource },
        zIndex: 10,
        draggable: true,
      })),
    )
    // visibleResourceKey is a stable surrogate — re-runs when IDs change, auth loads, or avatar changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleResources.map((r) => r.id).join(',') + '|' + (currentAuthUuid ?? '') + '|' + (avatarUrl ?? '')])

  const allEdges = useMemo(() => linksToEdges(links), [links])
  // Read once on mount; URL changes during a session trigger a remount.
  // No need to subscribe via useSearchParams here.
  const askUserOverride = useMemo(() => readAskUserOverride(), [])
  const cursorNodeList = useMemo(
    () => cursorNodes(cursors, nodes, askUserOverride),
    [cursors, nodes, askUserOverride],
  )
  const allNodes = useMemo(() => [...nodes, ...cursorNodeList], [nodes, cursorNodeList])

  const onNodeDrag = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const simNode = simNodesRef.current.find((n) => n.id === node.id)
      if (!simNode) return
      simNode.fx = node.position.x
      simNode.fy = node.position.y
      simRef.current?.alpha(0.2).restart()
    },
    [],
  )

  const onNodeDragStop = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const simNode = simNodesRef.current.find((n) => n.id === node.id)
      if (!simNode) return
      simNode.fx = null
      simNode.fy = null
      simRef.current?.alpha(0.4).restart()
    },
    [],
  )

  if (isPending) {
    return (
      <div className="w-full h-screen flex items-center justify-center bg-background dark:bg-zinc-900">
        <p className="text-muted-foreground">Loading graph…</p>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="w-full h-screen flex items-center justify-center bg-background dark:bg-zinc-900">
        <p className="text-destructive">Failed to load graph</p>
      </div>
    )
  }

  return (
    <div className="w-full h-screen bg-background dark:bg-zinc-900 relative">
      <div className="absolute top-4 left-4 z-10">
        <GraphFilter activeTypes={activeTypes} onToggle={toggleType} />
      </div>
      <ReactFlow
        nodes={allNodes}
        edges={allEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={4}
        proOptions={{ hideAttribution: true }}
      >
        <ForceController
          links={links}
          simNodesRef={simNodesRef}
          simRef={simRef as SimRef}
        />
        <Background variant={BackgroundVariant.Dots} className="dark:bg-zinc-900" />
      </ReactFlow>
    </div>
  )
}
