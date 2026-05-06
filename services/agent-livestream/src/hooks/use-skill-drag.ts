import { useRef, useCallback } from 'react'
import type { Node } from '@xyflow/react'
import type { SimNode } from '@/components/force-controller'
import type * as d3Force from 'd3-force'

const LOCALITY_RADIUS = 200

export function useSkillDrag({
  simNodesRef,
  simNodeMapRef,
  simRef,
  restartLoopRef,
}: {
  simNodesRef: React.MutableRefObject<SimNode[]>
  simNodeMapRef: React.MutableRefObject<Map<string, SimNode>>
  simRef: React.MutableRefObject<d3Force.Simulation<SimNode, d3Force.SimulationLinkDatum<SimNode>> | null>
  restartLoopRef: React.MutableRefObject<(() => void) | null>
}) {
  const dragFrozenRef = useRef<Set<string>>(new Set())

  const onNodeDragStart = useCallback((_: React.MouseEvent, node: Node) => {
    const dragged = simNodeMapRef.current.get(node.id)
    if (!dragged) return
    const frozen = new Set<string>()
    for (const simNode of simNodesRef.current) {
      if (simNode.id === node.id || simNode.fx != null || simNode.fy != null) continue
      const dx = (simNode.x ?? 0) - (dragged.x ?? 0)
      const dy = (simNode.y ?? 0) - (dragged.y ?? 0)
      if (Math.sqrt(dx * dx + dy * dy) > LOCALITY_RADIUS) {
        // eslint-disable-next-line react-hooks/immutability -- d3 SimNode mutation is intentional: pins node position during drag
        simNode.fx = simNode.x
        simNode.fy = simNode.y
        frozen.add(simNode.id)
      }
    }
    dragFrozenRef.current = frozen
  }, [simNodesRef, simNodeMapRef])

  const onNodeDrag = useCallback((_: React.MouseEvent, node: Node) => {
    const simNode = simNodeMapRef.current.get(node.id)
    if (!simNode) return
    simNode.fx = node.position.x
    simNode.fy = node.position.y
    const cx = node.position.x
    const cy = node.position.y
    for (const s of simNodesRef.current) {
      if (s.id === node.id) continue
      const dx = (s.x ?? 0) - cx
      const dy = (s.y ?? 0) - cy
      const inside = Math.sqrt(dx * dx + dy * dy) <= LOCALITY_RADIUS
      if (inside && dragFrozenRef.current.has(s.id)) {
        // eslint-disable-next-line react-hooks/immutability -- d3 SimNode mutation is intentional: unpins node as drag locality expands
        s.fx = undefined; s.fy = undefined
        dragFrozenRef.current.delete(s.id)
      } else if (!inside && !dragFrozenRef.current.has(s.id) && s.fx == null) {
        s.fx = s.x; s.fy = s.y
        dragFrozenRef.current.add(s.id)
      }
    }
    simRef.current?.alpha(0.08).restart()
    restartLoopRef.current?.()
  }, [simNodesRef, simNodeMapRef, simRef, restartLoopRef])

  const onNodeDragStop = useCallback((_: React.MouseEvent, node: Node) => {
    const simNode = simNodeMapRef.current.get(node.id)
    if (!simNode) return
    for (const id of dragFrozenRef.current) {
      const s = simNodeMapRef.current.get(id)
      if (s) { s.fx = undefined; s.fy = undefined }
    }
    dragFrozenRef.current.clear()
    simNode.fx = undefined
    simNode.fy = undefined
    simRef.current?.alpha(0.05).restart()
    restartLoopRef.current?.()
  }, [simNodeMapRef, simRef, restartLoopRef])

  return { onNodeDragStart, onNodeDrag, onNodeDragStop, dragFrozenRef }
}
