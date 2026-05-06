import { GitBranch, ArrowDownFromLine, ArrowRightFromLine } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import dagre from '@dagrejs/dagre'
import type { Resource, ResourceLink } from '@skill-networks/agent-events'
import type { LayoutAdapter } from './types'
import { BASE_SIZE, CARD_NODE_WIDTH, CARD_NODE_HEIGHT, graphScale } from '@/lib/graph-constants'

// Handles are at the circle CENTER. Outer node div is pinned to `width: dim` (= circle diameter)
// in skill-node.tsx so labels never expand the measured node width. Dagre therefore uses circle
// diameter for both width and height — no label width needed here.
//
// Dagre uses BASE_SIZE (gs=1) for spacing so the layout stays compact at any --graph-scale.
// The top-left offset applied to positions must use width*gs/2 so that the DOM element
// (rendered at BASE_SIZE*gs CSS pixels) is centered at the dagre center — keeping all handles
// at x_dagre regardless of node tier, which is required for symmetric edge routing.
function nodeDims(r: Resource, nodeStyle: string): { width: number; height: number } {
  const size = (r.config as { size?: string } | null)?.size ?? 'md'
  if (nodeStyle === 'card') {
    return { width: CARD_NODE_WIDTH[size] ?? 144, height: CARD_NODE_HEIGHT[size] ?? 92 }
  }
  const d = BASE_SIZE[size] ?? 64
  return { width: d, height: d }
}

// Data semantics: from_id = parent, to_id = child (link_type = "parent").
//
// Spanning tree: BFS from roots (nodes with no incoming child-edge, i.e. nothing sets them
// as a to_id). Shared children (multiple parents) are assigned to the first parent that
// reaches them via BFS, eliminating cross-links that flatten dagre's rank assignment.
//
// Edges whose endpoints are not both in `nodes` are discarded. The BFF's shouldKeepLink
// preserves `runs` links with a dangling to_id (to support cursor fallback), so the input
// `edges` array can reference resource IDs that were type-filtered out of `nodes`. If those
// dangling edges reach dagre.setEdge, dagre auto-creates phantom nodes and allocates subtree
// width for them — one agent with N invisible runs grandchildren ends up visually shoved
// sideways relative to its siblings.
//
// Uses an index pointer instead of Array.shift() to keep BFS O(n) on large graphs.
function buildSpanningTree(nodes: Resource[], edges: ResourceLink[]): ResourceLink[] {
  const validIds = new Set(nodes.map((n) => n.id))
  // children[parent_id] → edges where from_id === parent_id
  const children = new Map<string, ResourceLink[]>()
  // inDegree[child_id] = number of parents pointing to it
  const inDegree = new Map<string, number>()
  for (const n of nodes) inDegree.set(n.id, 0)
  for (const e of edges) {
    if (!validIds.has(e.from_id) || !validIds.has(e.to_id)) continue
    if (!children.has(e.from_id)) children.set(e.from_id, [])
    const bucket = children.get(e.from_id)
    if (bucket) bucket.push(e)
    inDegree.set(e.to_id, (inDegree.get(e.to_id) ?? 0) + 1)
  }

  const visited = new Set<string>()
  const treeEdges: ResourceLink[] = []

  function bfs(startIds: string[]) {
    const queue = [...startIds]
    for (const id of startIds) visited.add(id)
    let head = 0
    while (head < queue.length) {
      const id = queue[head++]
      for (const edge of (children.get(id) ?? [])) {
        if (!visited.has(edge.to_id)) {
          visited.add(edge.to_id)
          treeEdges.push(edge)
          queue.push(edge.to_id)
        }
      }
    }
  }

  // Roots = nodes with inDegree 0 (no parent points to them). Fall back to first node if
  // the graph is a pure cycle (unlikely in practice).
  const roots = nodes.filter(n => (inDegree.get(n.id) ?? 0) === 0).map(n => n.id)
  bfs(roots.length > 0 ? roots : nodes.slice(0, 1).map(n => n.id))

  // Handle disconnected components — start a new BFS from any unvisited node.
  for (const n of nodes) {
    if (!visited.has(n.id)) bfs([n.id])
  }

  return treeEdges
}

function computeTreeLayout(
  nodes: Resource[],
  edges: ResourceLink[],
  params: URLSearchParams,
): Map<string, { x: number; y: number }> {
  const direction = params.get('tree.direction') ?? 'TB'
  const nodeStyle = params.get('nodeStyle') ?? 'card'
  const treeEdges = buildSpanningTree(nodes, edges)

  // gs scales the DOM element size but NOT dagre's spacing. Position offset uses width*gs/2
  // so the larger DOM element (BASE_SIZE*gs CSS px) is still centered at the dagre center.
  const gs = graphScale()
  const isCard = nodeStyle === 'card'

  // Card nodes are wider so dagre needs less extra nodesep; rank spacing is tighter too.
  const NODESEP = isCard ? 80 : 331
  const RANKSEP = isCard ? 80 : 250

  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: direction, nodesep: NODESEP, ranksep: RANKSEP })

  const dimsCache = new Map<string, { width: number; height: number }>()
  for (const node of nodes) {
    const dims = nodeDims(node, nodeStyle)
    dimsCache.set(node.id, dims)
    g.setNode(node.id, { width: dims.width, height: dims.height })
  }
  // from_id = parent, to_id = child — correct dagre direction for top-down tree.
  for (const edge of treeEdges) {
    g.setEdge(edge.from_id, edge.to_id)
  }

  dagre.layout(g)

  // Collect dagre centers, then post-process to center parents over children.
  const centers = new Map<string, { x: number; y: number }>()
  for (const node of nodes) {
    centers.set(node.id, g.node(node.id) ?? { x: 0, y: 0 })
  }

  // Post-dagre: force symmetric centering for card mode org charts.
  // In TB mode center over x; in LR mode (siblings spread along y) center over y.
  if (isCard) {
    const childrenOf = new Map<string, string[]>()
    for (const edge of treeEdges) {
      const kids = childrenOf.get(edge.from_id) ?? []
      kids.push(edge.to_id)
      childrenOf.set(edge.from_id, kids)
    }
    // Process bottom-up (reverse BFS insertion order) so that when a grandparent
    // is centered, its children have already been re-centered over their own children.
    const axis = direction === 'LR' ? 'y' : 'x'
    const parentIds = [...childrenOf.keys()].reverse()
    for (const parentId of parentIds) {
      const childIds = childrenOf.get(parentId)!
      const parentCenter = centers.get(parentId)
      if (!parentCenter || childIds.length === 0) continue
      const childCoords = childIds.map((id) => centers.get(id)?.[axis]).filter((v): v is number => v != null)
      if (childCoords.length === 0) continue
      // Intentional in-place mutation: the final positions loop reads from this same Map.
      parentCenter[axis] = (Math.min(...childCoords) + Math.max(...childCoords)) / 2
    }
  }

  const positions = new Map<string, { x: number; y: number }>()
  for (const node of nodes) {
    const { x, y } = centers.get(node.id) ?? { x: 0, y: 0 }
    const { width, height } = dimsCache.get(node.id)!
    const scale = isCard ? 1 : gs
    positions.set(node.id, { x: x - width * scale / 2, y: y - height * scale / 2 })
  }
  return positions
}

function renderTreeControls(
  params: URLSearchParams,
  setParam: (key: string, value: string) => void,
): React.ReactNode {
  const direction = params.get('tree.direction') ?? 'TB'

  return (
    <ToggleGroup type="single" value={direction} onValueChange={(v) => v && setParam('tree.direction', v)} className="w-full gap-1">
      <ToggleGroupItem value="TB" className="flex-1 gap-1 text-xs h-7 px-2">
        <ArrowDownFromLine className="h-3 w-3" /> TB
      </ToggleGroupItem>
      <ToggleGroupItem value="LR" className="flex-1 gap-1 text-xs h-7 px-2">
        <ArrowRightFromLine className="h-3 w-3" /> LR
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

export const TreeLayoutAdapter: LayoutAdapter = {
  id: 'tree',
  label: 'Tree',
  icon: GitBranch,
  // Arrows point parent→child (downward) in tree view, opposite of force view.
  reverseEdgeDirection: true,
  controlsLabel: 'Direction',
  computeLayout: computeTreeLayout,
  filterEdges: buildSpanningTree,
  renderControls: renderTreeControls,
}
