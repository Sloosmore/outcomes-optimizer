import { getBezierPath, type EdgeProps, type Edge } from '@xyflow/react'

export type TrailEdgeData = {
  recency: number     // 0 = most recent (brightest), higher = older (dimmer)
  fillClass: string   // agent identity color for stroke (e.g. text-rose-500) tokens-ok
}

// Opacity steps: index 0 is the freshest edge (current → previous),
// each step back fades toward invisible.
const OPACITY = ['opacity-90', 'opacity-55', 'opacity-30', 'opacity-15', 'opacity-5'] as const

export function TrailEdge({
  sourceX, sourceY, sourcePosition,
  targetX, targetY, targetPosition,
  data,
}: EdgeProps<Edge<TrailEdgeData>>) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const idx = Math.min(data?.recency ?? 0, OPACITY.length - 1)
  const isDashed = (data?.recency ?? 0) > 0

  return (
    <path
      d={path}
      strokeLinecap="round"
      strokeDasharray={isDashed ? '8 5' : undefined}
      className={[
        'fill-none stroke-current stroke-2',
        OPACITY[idx],
        data?.fillClass ?? 'text-foreground',
      ].join(' ')}
    />
  )
}
