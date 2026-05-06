import { createLogger } from '@skill-networks/logger'
import type { ResourcesService } from '@skill-networks/database/services'
import type { MetricsService } from '@skill-networks/database/services'
import type { ProjectScope } from '@skill-networks/database/services'
import { enrichWithMetrics, enrichFormulaResources } from './enrichment.js'

const logger = createLogger('bff:graph')

type Row = Record<string, unknown>

type ServicesContext = {
  resources: ResourcesService
  metrics: MetricsService
}

/** Keep a link if both endpoints are in the tree, or if it is a "runs" link with its parent in the tree.
 * The "runs" exception lets cursor resolution fall back to the parent agent/user node when a child
 * skill resource has been filtered out of the resource list.
 */
function shouldKeepLink(l: Row, treeIds: Set<string>): boolean {
  const from = (l as { from_id: string }).from_id
  const to = (l as { to_id: string }).to_id
  if (treeIds.has(from) && treeIds.has(to)) return true
  if ((l as { link_type: string }).link_type === 'runs' && treeIds.has(from)) return true
  return false
}

function parseJsonSafe(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

export function coerceResourceConfig(row: Row): Row {
  return {
    ...row,
    config: typeof row.config === 'string' ? parseJsonSafe(row.config) : row.config,
  }
}

export function synthesizeLinkId(row: Row): Row {
  return { id: `${row.from_id as string}__${row.to_id as string}`, ...row }
}

/**
 * Filter resources to only those reachable from root(s) via parent links.
 * BFS from root nodes — resources that appear as parents but never as children.
 * If startFromIds is provided, use those as BFS roots instead of auto-detection.
 */
export function filterToOkrTree(
  resources: Row[],
  links: Row[],
  startFromIds?: string[],
): { resources: Row[]; links: Row[]; fallback: boolean } {
  const parentLinks = links.filter((l) => (l as { link_type: string }).link_type === 'parent')

  // Single pass: build adjacency map and both ID sets simultaneously
  const childrenOf = new Map<string, string[]>()
  const allChildIds = new Set<string>()
  const allParentIds = new Set<string>()
  for (const l of parentLinks) {
    const from = (l as { from_id: string }).from_id
    const to = (l as { to_id: string }).to_id
    const kids = childrenOf.get(from) ?? []
    kids.push(to)
    childrenOf.set(from, kids)
    allChildIds.add(to)
    allParentIds.add(from)
  }
  // Use provided roots OR auto-detect roots (parents that are never children)
  const rootIds = startFromIds ?? [...allParentIds].filter((id) => !allChildIds.has(id))

  const reachable = new Set<string>(rootIds)
  const queue = [...rootIds]
  let head = 0
  while (head < queue.length) {
    const id = queue[head++]
    for (const childId of childrenOf.get(id) ?? []) {
      if (!reachable.has(childId)) {
        reachable.add(childId)
        queue.push(childId)
      }
    }
  }

  if (reachable.size === 0) {
    return { resources, links, fallback: true }
  }

  // Exclude dispatched goal resources from the graph — they are skill type, have config.content
  // (goal markdown) but no config.size. Agent resources may also carry config.content (their
  // goal prompt) and must NOT be excluded.
  const filteredResources = resources.filter((r) => {
    if (!reachable.has(r.id as string)) return false
    const config = r.config as Record<string, unknown> | null
    if ((r as { type: string }).type !== 'agent' && config !== null && config.content && !('size' in config)) {
      logger.debug('Excluding dispatched goal resource from graph', { id: r.id })
      return false
    }
    return true
  })
  const treeIds = new Set(filteredResources.map((r) => r.id as string))
  const filteredLinks = links.filter((l) => shouldKeepLink(l, treeIds))

  return { resources: filteredResources, links: filteredLinks, fallback: false }
}

/**
 * Full graph pipeline: fetch resources + links, filter to OKR tree, enrich with metrics.
 * If opts.projectId is provided, BFS starts from that project resource.
 * If opts.scope is provided, authorization filtering is applied before OKR tree display filtering.
 * Project membership is resolved through parent links (ontology), not a column.
 */
export async function buildGraph(
  services: ServicesContext,
  types: string[],
  opts?: { scope?: ProjectScope; projectId?: string },
): Promise<{ resources: Row[]; links: Row[] }> {
  const projectId = opts?.projectId
  let allResources: Row[]
  let allLinks: Row[]

  if (types.length === 0 || projectId) {
    // No type filter OR project scoping with project-scoped types — need all resources + all links for correct BFS
    const [resourceData, linksData] = await Promise.all([
      services.resources.listActive(),
      services.resources.listAllLinks(),
    ])
    allResources = (resourceData as unknown as Row[]).map(coerceResourceConfig)
    allLinks = (linksData as unknown as Row[]).map(synthesizeLinkId)
  } else {
    // Type filter without project BFS — use efficient type-filtered query
    const resourceData = await services.resources.listActive({ types })
    allResources = (resourceData as unknown as Row[]).map(coerceResourceConfig)
    const allIds = allResources.map((r) => r.id as string)
    if (allIds.length === 0) {
      allLinks = []
    } else {
      const linksData = await services.resources.listLinksBetween(allIds)
      allLinks = (linksData as unknown as Row[]).map(synthesizeLinkId)
    }
  }

  // Authorization filtering: scope restricts which resources/links the user may see,
  // applied BEFORE filterToOkrTree (which handles display logic).
  if (opts?.scope) {
    allResources = opts.scope.filterResources(allResources as unknown as Array<{ id: string }>) as Row[]
    allLinks = opts.scope.filterLinks(allLinks as unknown as Array<{ from_id: string; to_id: string }>) as Row[]
  }

  // If projectId provided, restrict BFS to start from that project
  const startFromIds = projectId ? [projectId] : undefined

  const tree = filterToOkrTree(allResources, allLinks, startFromIds)

  // If types specified with projectId, filter the BFS result by type
  if (types.length > 0 && projectId) {
    const allowedTypes = new Set(types)
    tree.resources = tree.resources.filter((r) => allowedTypes.has((r as { type: string }).type))
    const treeIds = new Set(tree.resources.map((r) => r.id as string))
    tree.links = tree.links.filter((l) => shouldKeepLink(l, treeIds))
  }

  if (tree.fallback) {
    logger.warn('OKR tree filter found no root nodes — falling back to unfiltered graph', {
      parentLinkCount: allLinks.filter((l) => (l as { link_type: string }).link_type === 'parent').length,
    })
  }

  // enrichWithMetrics must run before enrichFormulaResources: formula evaluation reads
  // config.history that enrichWithMetrics populates, ensuring formulas use only canonical
  // per-skill snapshots rather than unfiltered cross-skill metric_snapshots data.
  await enrichWithMetrics(services.metrics, tree.resources as unknown as Array<Record<string, unknown> & { id: string; type: string; config: Record<string, unknown> }>)
  enrichFormulaResources(tree.resources as unknown as Array<Record<string, unknown> & { id: string; type: string; config: Record<string, unknown> }>)

  return { resources: tree.resources, links: tree.links }
}
