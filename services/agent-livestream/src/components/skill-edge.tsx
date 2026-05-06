import { type Edge, type EdgeProps, getStraightPath, getSmoothStepPath, Position } from '@xyflow/react'
import { BASE_RADIUS, CARD_HALF_WIDTH, CARD_HALF_HEIGHT, graphScale } from '@/lib/graph-constants'

type SkillEdgePayload = { sourceSize?: string; targetSize?: string; edgeStyle?: string; linestyle?: string; treeDirection?: string; nodeStyle?: string } & Record<string, unknown>
export type SkillEdgeData = Edge<SkillEdgePayload>

/** Cache graphScale per animation frame — avoids repeated getComputedStyle() calls during zoom.
 *  Quantize to ~16 ms buckets (≈ one 60 fps frame) so the cache is effective during zoom gestures. */
let cachedGs = 1
let cacheFrame = -1
function getCachedGs(): number {
  const frame = Math.floor(performance.now() / 16)
  if (frame !== cacheFrame) {
    cachedGs = graphScale()
    cacheFrame = frame
  }
  return cachedGs
}

export function SkillEdge({
  id, sourceX, sourceY, targetX, targetY, markerEnd, data,
}: EdgeProps<SkillEdgeData>) {
  const isCard = data?.nodeStyle === 'card'
  const edgeStyle = data?.edgeStyle ?? 'step'
  const isDashed = data?.linestyle === 'dashed'
  const isLR = data?.treeDirection === 'LR'

  const gs = isCard ? 1 : getCachedGs()

  const sourceSize = data?.sourceSize ?? 'md'
  const targetSize = data?.targetSize ?? 'md'

  // Exit/entry offsets from node center
  let sExit: { dx: number; dy: number }
  let tEntry: { dx: number; dy: number }
  if (isCard) {
    const shw = CARD_HALF_WIDTH[sourceSize] ?? 80
    const shh = CARD_HALF_HEIGHT[sourceSize] ?? 58
    const thw = CARD_HALF_WIDTH[targetSize] ?? 80
    const thh = CARD_HALF_HEIGHT[targetSize] ?? 58
    sExit = isLR ? { dx: shw, dy: 0 } : { dx: 0, dy: shh }
    tEntry = isLR ? { dx: -(thw + 6), dy: 0 } : { dx: 0, dy: -(thh + 6) }
  } else {
    const sr = (BASE_RADIUS[sourceSize] ?? 32) * gs
    const tr = (BASE_RADIUS[targetSize] ?? 32) * gs
    sExit = isLR ? { dx: sr, dy: 0 } : { dx: 0, dy: sr }
    tEntry = isLR ? { dx: -(tr + 6 * gs), dy: 0 } : { dx: 0, dy: -(tr + 6 * gs) }
  }

  const dx = targetX - sourceX
  const dy = targetY - sourceY
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist < 2) return null

  let edgePath: string
  if (edgeStyle === 'bracket') {
    // Bracket: vertical down from parent → horizontal to child X → vertical down to child.
    // All siblings sharing the same parent use the same midpoint, so horizontal segments
    // overlap into one visible bar — the classic org chart bracket.
    const sx = sourceX + sExit.dx
    const sy = sourceY + sExit.dy
    const tx = targetX + tEntry.dx
    const ty = targetY + tEntry.dy
    if (isLR) {
      const midX = sx + (tx - sx) / 2
      edgePath = `M ${sx} ${sy} L ${midX} ${sy} L ${midX} ${ty} L ${tx} ${ty}`
    } else {
      const midY = sy + (ty - sy) / 2
      edgePath = `M ${sx} ${sy} L ${sx} ${midY} L ${tx} ${midY} L ${tx} ${ty}`
    }
  } else if (edgeStyle === 'step') {
    ;[edgePath] = getSmoothStepPath({
      sourceX: sourceX + sExit.dx,
      sourceY: sourceY + sExit.dy,
      sourcePosition: isLR ? Position.Right : Position.Bottom,
      targetX: targetX + tEntry.dx,
      targetY: targetY + tEntry.dy,
      targetPosition: isLR ? Position.Left : Position.Top,
      borderRadius: 8,
    })
  } else {
    const sr = isCard ? (CARD_HALF_HEIGHT[sourceSize] ?? 58) : (BASE_RADIUS[sourceSize] ?? 32) * gs
    const tr = isCard ? (CARD_HALF_HEIGHT[targetSize] ?? 58) : (BASE_RADIUS[targetSize] ?? 32) * gs
    const ux = dx / dist
    const uy = dy / dist
    ;[edgePath] = getStraightPath({
      sourceX: sourceX + ux * sr,
      sourceY: sourceY + uy * sr,
      targetX: targetX - ux * (tr + 6 * (isCard ? 1 : gs)),
      targetY: targetY - uy * (tr + 6 * (isCard ? 1 : gs)),
    })
  }

  const sw = isCard ? 4 : 4 * gs
  const dash = isDashed ? `${isCard ? 6 : 6 * gs} ${isCard ? 4 : 4 * gs}` : undefined

  return (
    <>
      <path id={id} d={edgePath} className="stroke-muted-foreground fill-none opacity-60" strokeWidth={sw} strokeDasharray={dash} markerEnd={markerEnd} />
      <path d={edgePath} fill="none" strokeWidth={20} stroke="transparent" className="react-flow__edge-interaction" />
    </>
  )
}
