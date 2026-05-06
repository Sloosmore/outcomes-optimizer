import type React from 'react'
import type { LucideIcon } from 'lucide-react'
import type { Resource, ResourceLink } from '@skill-networks/agent-events'

export interface LayoutAdapter {
  id: string
  label: string
  icon: LucideIcon
  // Compute static node positions. Returns null if layout is dynamic (ForceController owns it).
  computeLayout(
    nodes: Resource[],
    edges: ResourceLink[],
    params: URLSearchParams,
  ): Map<string, { x: number; y: number }> | null
  // Filter which edges are rendered. If absent, all edges are shown.
  filterEdges?: (nodes: Resource[], edges: ResourceLink[]) => ResourceLink[]
  // When true, swap ReactFlow source/target so arrows point parent→child instead of child→parent.
  reverseEdgeDirection?: boolean
  // Label shown above adapter-specific controls in the display options panel.
  controlsLabel?: string
  // Extra controls rendered in the display options panel (e.g. direction toggle for tree).
  renderControls?: (
    params: URLSearchParams,
    setParam: (key: string, value: string) => void,
  ) => React.ReactNode
}
