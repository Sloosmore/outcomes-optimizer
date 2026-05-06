import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { Node, Edge } from '@xyflow/react'
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force'

interface ForceNode extends SimulationNodeDatum {
  id: string
}

interface ForceLink extends SimulationLinkDatum<ForceNode> {
  id: string
}

export function useForceLayout(
  initialNodes: Node[],
  edges: Edge[],
  setNodes: Dispatch<SetStateAction<Node[]>>,
) {
  const initialized = useRef(false)

  useEffect(() => {
    if (initialized.current || !initialNodes?.length) return
    initialized.current = true

    const forceNodes: ForceNode[] = initialNodes.map((n) => ({
      id: n.id,
      x: n.position.x,
      y: n.position.y,
    }))

    const nodeById = new Map(forceNodes.map((n) => [n.id, n]))

    const forceLinks: ForceLink[] = edges
      .filter((e) => nodeById.has(e.source) && nodeById.has(e.target))
      .map((e) => ({
        id: e.id,
        source: nodeById.get(e.source)!,
        target: nodeById.get(e.target)!,
      }))

    const sim = forceSimulation<ForceNode>(forceNodes)
      .force(
        'link',
        forceLink<ForceNode, ForceLink>(forceLinks)
          .id((d) => d.id)
          .distance(220)
          .strength(0.4),
      )
      .force('charge', forceManyBody().strength(-800))
      .force('center', forceCenter(0, 0).strength(0.05))
      .force('collide', forceCollide(110))
      .alphaDecay(0.015)
      .velocityDecay(0.4)

    sim.on('tick', () => {
      setNodes((prev) =>
        prev.map((n) => {
          const fn = nodeById.get(n.id)
          if (!fn || fn.x == null || fn.y == null) return n
          return { ...n, position: { x: fn.x, y: fn.y } }
        }),
      )
    })

    return () => {
      sim.stop()
    }
  }, [initialNodes, edges, setNodes])
}
