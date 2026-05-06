import '@xyflow/react/dist/style.css'
import { useEffect, useRef, useMemo } from 'react'
import {
  ReactFlow, Background, BackgroundVariant, Panel,
  useNodesState, useEdgesState, useReactFlow,
  type Node, type Edge,
} from '@xyflow/react'
import type { Resource, ResourceLink } from '@skill-networks/agent-events'
import * as d3Force from 'd3-force'
import { OntologyNode } from '@/components/ui/ontology-node'
import { TrailEdge } from '@/components/trail-edge'
import { StructuralEdge } from '@/components/structural-edge'
import { ForceController } from '@/components/force-controller'
import type { SimNode } from '@/components/force-controller'
import { agentColor } from '@/lib/agent-colors'
import { EpochProgress } from '@/components/epoch-progress'

const NODE_TYPES = { ontologyNode: OntologyNode }
const EDGE_TYPES = { trailEdge: TrailEdge, structuralEdge: StructuralEdge }

function AutoFit() {
  const { fitView } = useReactFlow()
  // Sync ReactFlow viewport on mount — external Zustand store, not React state
  useEffect(() => {
    const frame = requestAnimationFrame(() => fitView({ duration: 500, padding: 0.4 }))
    return () => cancelAnimationFrame(frame)
    // fitView is stable — runs once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

interface ActivityGraphProps {
  resources: Resource[]
  links: ResourceLink[]
  visitPath: string[]              // agent touch order, oldest first
  touchMap: Record<string, string> // resource_id → source (e.g. "proxy.credential_fetch")
  processId: string
}

export function ActivityGraph({ resources, links, visitPath, touchMap, processId }: ActivityGraphProps) {
  const color = agentColor(processId)
  const visitedSet = useMemo(() => new Set(visitPath), [visitPath])

  const simNodesRef = useRef<SimNode[]>([])
  const simNodeMapRef = useRef<Map<string, SimNode>>(new Map())
  const simRef = useRef<d3Force.Simulation<SimNode, d3Force.SimulationLinkDatum<SimNode>> | null>(null)
  const restartLoopRef = useRef<(() => void) | null>(null)
  const positionCacheRef = useRef<Map<string, { x: number; y: number }>>(new Map())

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [, , onEdgesChange] = useEdgesState<Edge>([])

  const resourceKey = useMemo(() => resources.map((r) => r.id).join(','), [resources])
  const visitedKey = useMemo(() => visitPath.join(','), [visitPath])

  // Persist positions across re-renders
  useEffect(() => {
    for (const node of nodes) {
      positionCacheRef.current.set(node.id, node.position)
    }
  })

  // Rebuild nodes when resources or visited set changes — positions preserved via cache
  // Valid exception: setNodes syncs into ReactFlow's external Zustand store
  useEffect(() => {
    if (resources.length === 0) return
     
    setNodes(resources.map((resource) => ({
      id: resource.id,
      type: 'ontologyNode' as const,
      position: positionCacheRef.current.get(resource.id) ?? {
        x: (Math.random() - 0.5) * 1200,
        y: (Math.random() - 0.5) * 800,
      },
      data: {
        resource,
        isVisited: visitedSet.has(resource.id),
        touchSource: touchMap[resource.id],
      },
      draggable: true,
    })))
    // resourceKey and visitedKey are stable surrogates — re-run when either changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceKey, visitedKey])

  const structuralEdges = useMemo<Edge[]>(() =>
    links.map((link) => ({
      id: link.id,
      source: link.from_id,
      target: link.to_id,
      type: 'structuralEdge' as const,
    })),
  [links])

  const trailEdges = useMemo<Edge[]>(() =>
    visitPath.slice(1).map((toId, i) => ({
      id: `trail-${visitPath[i]}-${toId}`,
      source: visitPath[i],
      target: toId,
      type: 'trailEdge' as const,
      zIndex: 10,
      data: { recency: visitPath.length - 2 - i, fillClass: color.fill },
    })),
  [visitPath, color.fill])

  const allEdges = useMemo(() => [...structuralEdges, ...trailEdges], [structuralEdges, trailEdges])

  return (
    <ReactFlow
      nodes={nodes}
      edges={allEdges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      fitView
      fitViewOptions={{ padding: 0.4 }}
      minZoom={0.05}
      maxZoom={4}
    >
      <ForceController
        links={links}
        simNodesRef={simNodesRef}
        simNodeMapRef={simNodeMapRef}
        simRef={simRef}
        restartLoopRef={restartLoopRef}
      />
      <AutoFit />
      <Background variant={BackgroundVariant.Dots} className="bg-background" gap={32} size={1} />
      <Panel position="bottom-left"><EpochProgress processId={processId} /></Panel>
    </ReactFlow>
  )
}
