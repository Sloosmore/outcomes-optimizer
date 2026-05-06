/* eslint-disable react-refresh/only-export-components -- utility helpers co-located with ForceController for single-import ergonomics */
import { useEffect, useRef } from 'react'
import {
  useReactFlow,
  useNodesInitialized,
  useStore,
} from '@xyflow/react'
import type { ResourceLink } from '@skill-networks/agent-events'
import * as d3Force from 'd3-force'

// Only rebuild simulation when node count changes — not on every position update
const nodeCountSelector = (state: { nodeLookup: Map<string, unknown> }) =>
  state.nodeLookup.size

export interface SimNode extends d3Force.SimulationNodeDatum {
  id: string
}

export type SimRef = React.MutableRefObject<d3Force.Simulation<SimNode, d3Force.SimulationLinkDatum<SimNode>> | null>

// Runs INSIDE ReactFlow's context so it can use useReactFlow() + useNodesInitialized()
export function ForceController({
  links,
  simNodesRef,
  simRef,
}: {
  links: ResourceLink[]
  simNodesRef: React.MutableRefObject<SimNode[]>
  simRef: SimRef
}) {
  const { getNodes, setNodes } = useReactFlow()
  const nodesInitialized = useNodesInitialized()
  const nodeCount = useStore(nodeCountSelector)
  const rafRef = useRef<number | null>(null)
  const activeRef = useRef(false)

  useEffect(() => {
    if (!nodesInitialized || nodeCount === 0) return

    // Cancel any running loop
    activeRef.current = false
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    simRef.current?.stop()

    const rfNodes = getNodes()
    const simNodes: SimNode[] = rfNodes.map((n) => ({
      id: n.id,
      x: n.position.x,
      y: n.position.y,
    }))

    const simLinks = links
      .filter((l) =>
        rfNodes.some((n) => n.id === l.from_id) &&
        rfNodes.some((n) => n.id === l.to_id),
      )
      .map((l) => ({ source: l.from_id, target: l.to_id }))

    const sim = d3Force
      .forceSimulation<SimNode>(simNodes)
      .force('charge', d3Force.forceManyBody().strength(-600).distanceMax(500))
      .force(
        'link',
        d3Force
          .forceLink<SimNode, d3Force.SimulationLinkDatum<SimNode>>(simLinks)
          .id((d) => d.id)
          .distance(160),
      )
      .force('collision', d3Force.forceCollide(60))
      .force('center', d3Force.forceCenter(0, 0))
      .alphaDecay(0.04)
      .stop()

    simRef.current = sim
    simNodesRef.current = simNodes

    activeRef.current = true

    const loop = () => {
      if (!activeRef.current) return

      if (sim.alpha() > sim.alphaMin()) {
        sim.tick()
        setNodes((currentNodes) =>
          currentNodes.map((rfNode) => {
            const simNode = simNodes.find((s) => s.id === rfNode.id)
            if (!simNode) return rfNode
            return {
              ...rfNode,
              position: { x: simNode.x ?? rfNode.position.x, y: simNode.y ?? rfNode.position.y },
            }
          }),
        )
      }

      rafRef.current = requestAnimationFrame(loop)
    }

    rafRef.current = requestAnimationFrame(loop)

    return () => {
      activeRef.current = false
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      sim.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodesInitialized, nodeCount])

  return null
}

export function linksToEdges(links: ResourceLink[]) {
  return links.map((link) => ({
    id: link.id,
    source: link.from_id,
    target: link.to_id,
    type: 'straight',
  }))
}
