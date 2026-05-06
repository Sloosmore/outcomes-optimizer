import type { Resource, ResourceLink } from '@skill-networks/agent-events'
import { BASE_SIZE, graphScale } from './graph-constants'

interface Position { x: number; y: number }

/**
 * Compute a deterministic radial tree layout from a resource graph.
 *
 * Places the root (xl) at center, then distributes children evenly around
 * concentric rings based on depth. Same input always produces same output.
 *
 * Links encode parent→child as from_id→to_id.
 */
export function radialLayout(
  resources: Resource[],
  links: ResourceLink[],
): Map<string, Position> {
  const gs = graphScale()
  const positions = new Map<string, Position>()

  if (resources.length === 0) return positions

  // Build adjacency: parent → children[]
  const children = new Map<string, string[]>()
  const hasParent = new Set<string>()
  for (const link of links) {
    const siblings = children.get(link.from_id) ?? []
    siblings.push(link.to_id)
    children.set(link.from_id, siblings)
    hasParent.add(link.to_id)
  }

  // Find root(s) — nodes with no parent. Prefer xl-sized nodes.
  const resourceMap = new Map(resources.map((r) => [r.id, r]))
  const roots = resources.filter((r) => !hasParent.has(r.id))

  // If no clear root, pick the xl node or first resource
  const root = roots.find((r) => nodeSize(r) === 'xl') ?? roots[0] ?? resources[0]
  if (!root) return positions

  // Ring radii per depth tier — scaled by --graph-scale
  const ringRadius = [0, 350 * gs, 600 * gs, 800 * gs, 950 * gs]

  // BFS to assign depth and collect children per level
  const depth = new Map<string, number>()
  const queue: string[] = [root.id]
  depth.set(root.id, 0)

  while (queue.length > 0) {
    const id = queue.shift()
    if (!id) continue
    const d = depth.get(id) ?? 0
    const kids = children.get(id) ?? []
    for (const kid of kids) {
      if (!depth.has(kid)) {
        depth.set(kid, d + 1)
        queue.push(kid)
      }
    }
  }

  // Handle orphan nodes (no links) — assign them to depth based on their size
  for (const r of resources) {
    if (!depth.has(r.id)) {
      const size = nodeSize(r)
      const d = size === 'xl' ? 0 : size === 'lg' ? 1 : size === 'md' ? 2 : 3
      depth.set(r.id, d)
    }
  }

  // Place root at center
  positions.set(root.id, { x: 0, y: 0 })

  // Group nodes by parent for angular distribution
  // For each parent, spread its children evenly around the parent's angle
  const parentAngle = new Map<string, number>()
  parentAngle.set(root.id, 0)

  // Process by depth level
  const maxDepth = Math.max(...depth.values())
  for (let d = 1; d <= maxDepth; d++) {
    const nodesAtDepth = resources.filter((r) => depth.get(r.id) === d)
    const radius = ringRadius[Math.min(d, ringRadius.length - 1)]

    // Group by parent
    const byParent = new Map<string, Resource[]>()
    const orphansAtDepth: Resource[] = []

    for (const node of nodesAtDepth) {
      // Find parent from links
      const parent = links.find((l) => l.to_id === node.id)?.from_id
      if (parent && positions.has(parent)) {
        const group = byParent.get(parent) ?? []
        group.push(node)
        byParent.set(parent, group)
      } else {
        orphansAtDepth.push(node)
      }
    }

    // Place children of each parent, centered around the parent's angle
    // nodesAtDepth already includes orphans — don't double-count them
    const angularSlice = (2 * Math.PI) / Math.max(nodesAtDepth.length, 1)
    let globalIndex = 0

    for (const [parentId, kids] of byParent) {
      const pAngle = parentAngle.get(parentId) ?? 0
      const spread = angularSlice * kids.length
      const startAngle = pAngle - spread / 2 + angularSlice / 2

      for (let i = 0; i < kids.length; i++) {
        const angle = startAngle + i * angularSlice
        positions.set(kids[i].id, {
          x: radius * Math.cos(angle),
          y: radius * Math.sin(angle),
        })
        parentAngle.set(kids[i].id, angle)
        globalIndex++
      }
    }

    // Place orphans (nodes at this depth with no positioned parent)
    for (const orphan of orphansAtDepth) {
      const angle = (globalIndex / Math.max(nodesAtDepth.length, 1)) * 2 * Math.PI
      positions.set(orphan.id, {
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle),
      })
      parentAngle.set(orphan.id, angle)
      globalIndex++
    }
  }

  // Offset positions so ReactFlow's top-left anchor is centered on the node
  for (const [id, pos] of positions) {
    const r = resourceMap.get(id)
    const size = r ? nodeSize(r) : 'md'
    const dim = (BASE_SIZE[size] ?? 64) * gs
    positions.set(id, { x: pos.x - dim / 2, y: pos.y - dim / 2 })
  }

  return positions
}

function nodeSize(r: Resource): string {
  return (r.config as { size?: string } | null)?.size ?? 'md'
}
