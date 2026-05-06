import type postgres from 'postgres'
import { ENFORCE_PROJECT_SCOPING } from '../constants.js'

type Sql = ReturnType<typeof postgres>

export interface ProjectScope {
  resourceIds: Set<string>
  projectIds: Set<string>
  has(resourceId: string): boolean
  filterResources<T extends { id: string }>(rows: T[]): T[]
  filterLinks<T extends { from_id: string; to_id: string }>(links: T[]): T[]
  filterProcesses<T extends { project_id: string | null }>(rows: T[]): T[]
}

const DEFAULT_TRAVERSE_LINKS = ['parent', 'runs']
const MAX_SCOPE_NODES = 5000

export class ProjectScopeService {
  constructor(private sql: Sql) {}

  async resolve(opts: {
    roots: string[]
    traverseLinks?: string[]
  }): Promise<ProjectScope> {
    if (ENFORCE_PROJECT_SCOPING && opts.roots.length === 0) {
      const empty = new Set<string>()
      return {
        resourceIds: empty,
        projectIds: empty,
        has: () => false,
        filterResources: () => [],
        filterLinks: () => [],
        filterProcesses: () => [],
      }
    }

    const traverseLinks = opts.traverseLinks ?? DEFAULT_TRAVERSE_LINKS
    const projectIds = new Set<string>(opts.roots)

    // Single DB round-trip via recursive CTE (replaces N+1 application-level BFS)
    const rows = await this.sql<{ resource_id: string }[]>`
      SELECT resource_id FROM resolve_project_scope(
        ${opts.roots}::uuid[],
        ${traverseLinks}::text[],
        ${MAX_SCOPE_NODES}
      )
    `
    const resourceIds = new Set<string>(rows.map(r => r.resource_id))

    return {
      resourceIds,
      projectIds,
      has(resourceId: string): boolean {
        return resourceIds.has(resourceId)
      },
      filterResources<T extends { id: string }>(rows: T[]): T[] {
        return rows.filter(r => resourceIds.has(r.id))
      },
      filterLinks<T extends { from_id: string; to_id: string }>(links: T[]): T[] {
        return links.filter(l => resourceIds.has(l.from_id) && resourceIds.has(l.to_id))
      },
      filterProcesses<T extends { project_id: string | null }>(rows: T[]): T[] {
        return rows.filter(r => r.project_id !== null && projectIds.has(r.project_id))
      },
    }
  }
}
