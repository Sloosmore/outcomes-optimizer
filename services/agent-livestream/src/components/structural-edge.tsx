import { getBezierPath, type EdgeProps, type Edge } from '@xyflow/react'

// Dim background edge — shows structural relationships between resources.
// Trail edges render on top via zIndex; these form the base graph layer.
export function StructuralEdge({
  sourceX, sourceY, sourcePosition,
  targetX, targetY, targetPosition,
}: EdgeProps<Edge>) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  return (
    <path
      d={path}
      className="fill-none stroke-current text-muted-foreground opacity-20 stroke-1"
    />
  )
}
