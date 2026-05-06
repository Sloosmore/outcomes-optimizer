import { useEffect, useRef, useMemo } from 'react'
import { useReactFlow, useNodesInitialized, useStore } from '@xyflow/react'
import * as d3Force from 'd3-force'
import type { ResourceLink } from '@skill-networks/agent-events'
import { graphScale } from '@/lib/graph-constants'

// Only rebuild simulation when node count changes — not on every position update
const nodeCountSelector = (state: { nodeLookup: Map<string, unknown> }) =>
  state.nodeLookup.size

export interface SimNode extends d3Force.SimulationNodeDatum {
  id: string
}

// Runs INSIDE ReactFlow's context so it can use useReactFlow() + useNodesInitialized()
export function ForceController({
  links,
  simNodesRef,
  simNodeMapRef,
  simRef,
  restartLoopRef,
}: {
  links: ResourceLink[]
  simNodesRef: React.MutableRefObject<SimNode[]>
  simNodeMapRef: React.MutableRefObject<Map<string, SimNode>>
  simRef: React.MutableRefObject<d3Force.Simulation<SimNode, d3Force.SimulationLinkDatum<SimNode>> | null>
  restartLoopRef: React.MutableRefObject<(() => void) | null>
}) {
  const { getNodes, setNodes } = useReactFlow()
  const nodesInitialized = useNodesInitialized()
  const nodeCount = useStore(nodeCountSelector)
  // Stable surrogate for links — rebuilds simulation when edges are added/removed
  const linkKey = useMemo(() => links.map((l) => l.id).join(','), [links])
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

    // Build a Set for O(1) node ID lookups when filtering links
    const nodeIds = new Set(rfNodes.map((n) => n.id))
    // Extract node sizes so link distance scales with tree depth (xl→lg far, lg→md close)
    const nodeSizeMap = new Map(
      rfNodes.map((n) => {
        const config = (n.data as { resource?: { config?: { size?: string } } }).resource?.config
        return [n.id, config?.size ?? 'md']
      }),
    )
    const gs = graphScale()

    const baseDist: Record<string, number> = { xl: 400, lg: 300, md: 180, sm: 110 }
    const simLinks = links
      .filter((l) => nodeIds.has(l.from_id) && nodeIds.has(l.to_id))
      .map((l) => ({
        source: l.from_id,
        target: l.to_id,
        dist: (baseDist[nodeSizeMap.get(l.to_id) ?? 'md'] ?? 150) * gs,
      }))

    type SimLink = (typeof simLinks)[number]

    // Larger collision radii push same-tier siblings apart more evenly
    const baseCollision: Record<string, number> = { xl: 180, lg: 130, md: 90, sm: 60 }

    // Per-node charge: deeper nodes get stronger repulsion relative to their size
    // so siblings at the same tier spread out instead of clumping
    const baseCharge: Record<string, number> = { xl: -1500, lg: -1200, md: -800, sm: -500 }

    // Radial ring distances from center — each tier orbits at a fixed radius
    const baseRing: Record<string, number> = { xl: 0, lg: 350, md: 600, sm: 800 }

    const sim = d3Force
      .forceSimulation<SimNode>(simNodes)
      .force('charge', d3Force.forceManyBody<SimNode>()
        .strength((n) => (baseCharge[nodeSizeMap.get(n.id) ?? 'md'] ?? -800) * gs)
        .distanceMax(900 * gs))
      .force(
        'link',
        d3Force
          .forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance((l) => l.dist),
      )
      // Pull each tier toward its concentric ring — creates the orbital layout
      .force('radial', d3Force.forceRadial<SimNode>(
        (n) => (baseRing[nodeSizeMap.get(n.id) ?? 'md'] ?? 400) * gs,
        0, 0,
      ).strength(0.4))
      // Per-node collision radius — prevents overlap and enforces spacing between siblings
      .force('collision', d3Force.forceCollide<SimNode>((n) => {
        const size = nodeSizeMap.get(n.id) ?? 'md'
        return (baseCollision[size] ?? 90) * gs
      }).strength(0.9))
      .force('center', d3Force.forceCenter(0, 0))
      .alphaDecay(0.03)
      .stop() // We drive ticks manually via rAF

    // Cast — callers only use alpha/restart/stop; link type param is irrelevant
    simRef.current = sim as unknown as d3Force.Simulation<SimNode, d3Force.SimulationLinkDatum<SimNode>>
    simNodesRef.current = simNodes

    // Build a Map for O(1) lookups inside the hot rAF loop and drag handlers
    const simNodeMap = new Map(simNodes.map((s) => [s.id, s]))
    simNodeMapRef.current = simNodeMap

    activeRef.current = true

    const loop = () => {
      if (!activeRef.current) return

      if (sim.alpha() > sim.alphaMin()) {
        sim.tick()
        // Valid exception: setNodes syncs into ReactFlow's external Zustand store, not React state.
         
        setNodes((currentNodes) =>
          currentNodes.map((rfNode) => {
            const simNode = simNodeMap.get(rfNode.id)
            if (!simNode) return rfNode
            return {
              ...rfNode,
              position: { x: simNode.x ?? rfNode.position.x, y: simNode.y ?? rfNode.position.y },
            }
          }),
        )
        rafRef.current = requestAnimationFrame(loop)
      } else {
        // Simulation has cooled — stop the loop to avoid idle CPU usage.
        // Drag handlers will call restartLoopRef.current() to resume.
        rafRef.current = null
      }
    }

    // Expose loop restart for drag handlers in the parent
    restartLoopRef.current = () => {
      if (rafRef.current === null && activeRef.current) {
        rafRef.current = requestAnimationFrame(loop)
      }
    }

    rafRef.current = requestAnimationFrame(loop)

    return () => {
      activeRef.current = false
      restartLoopRef.current = null
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      sim.stop()
    }
    // Simulation rebuilds when node count, initialization state, or link topology changes.
    // getNodes/setNodes are stable refs from useReactFlow; ref props
    // (simNodesRef, simNodeMapRef, simRef, restartLoopRef) are read via .current
    // inside the effect — adding them would cause unnecessary teardown/rebuild cycles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodesInitialized, nodeCount, linkKey])

  return null
}
