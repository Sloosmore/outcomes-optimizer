import { useNodes, ViewportPortal } from '@xyflow/react'
import { useMemo } from 'react'
import type { ResourceLink } from '@skill-networks/agent-events'

interface BracketOverlayProps {
  links: ResourceLink[]
}

/**
 * Draws ⊓-shaped brackets between parent nodes and their children groups.
 * Uses ViewportPortal so coordinates map 1:1 with React Flow node positions.
 * Link semantics: from_id = parent, to_id = child. Bracket direction is always parent→child.
 */
export function BracketOverlay({ links }: BracketOverlayProps) {
  const nodes = useNodes()

  const brackets = useMemo(() => {
    const nodeMap = new Map(nodes.map((n) => [n.id, n]))

    // Group children by parent.
    // Link semantics: from_id = parent, to_id = child (link_type "parent").
    // The `reversed` flag only affects edge rendering direction, not data semantics.
    const childrenByParent = new Map<string, string[]>()
    for (const link of links) {
      const parentId = link.from_id
      const childId = link.to_id
      const kids = childrenByParent.get(parentId) ?? []
      kids.push(childId)
      childrenByParent.set(parentId, kids)
    }

    const result: { key: string; path: string }[] = []

    for (const [parentId, childIds] of childrenByParent) {
      const parent = nodeMap.get(parentId)
      if (!parent?.measured?.width || !parent?.measured?.height) continue

      const children = childIds
        .map((id) => nodeMap.get(id))
        .filter((n) => n?.measured?.width && n?.measured?.height)
      if (children.length === 0) continue

      // Parent bottom center
      const px = parent.position.x + parent.measured.width / 2
      const py = parent.position.y + parent.measured.height

      // Children bounding box
      let minX = Infinity
      let maxX = -Infinity
      let minTop = Infinity
      for (const child of children) {
        if (!child) continue
        minX = Math.min(minX, child.position.x)
        maxX = Math.max(maxX, child.position.x + (child.measured?.width ?? 0))
        minTop = Math.min(minTop, child.position.y)
      }

      // Bracket geometry — skip if children are above or too close to the parent
      const gap = minTop - py
      if (gap < 10) continue
      const barY = py + gap * 0.4
      const overhang = 40
      const dropLen = gap * 0.35
      const left = minX - overhang
      const right = maxX + overhang
      const r = 6

      const path = [
        // Vertical stub from parent bottom
        `M ${px} ${py} L ${px} ${barY}`,
        // Horizontal bar with rounded corners dropping down on each end
        `M ${left} ${barY + dropLen}`,
        `L ${left} ${barY + r}`,
        `Q ${left} ${barY} ${left + r} ${barY}`,
        `L ${right - r} ${barY}`,
        `Q ${right} ${barY} ${right} ${barY + r}`,
        `L ${right} ${barY + dropLen}`,
      ].join(' ')

      result.push({ key: parentId, path })
    }

    return result
  }, [nodes, links])

  if (brackets.length === 0) return null

  return (
    <ViewportPortal>
      <svg className="pointer-events-none absolute top-0 left-0 overflow-visible">
        {brackets.map((b) => (
          <path
            key={b.key}
            d={b.path}
            className="stroke-muted-foreground fill-none opacity-60"
            strokeWidth={3}
          />
        ))}
      </svg>
    </ViewportPortal>
  )
}
