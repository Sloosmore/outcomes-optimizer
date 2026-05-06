import { z } from 'zod'
import type { ResourcesService } from '@skill-networks/database/services'
import type { ProcessesService } from '@skill-networks/database/services'
import { ApiProcessSchema } from '@skill-networks/contracts/processes'
import type { ApiProcess } from '@skill-networks/contracts/processes'

type ProcessRow = Record<string, unknown> & {
  name: string
  skill_resource_id: string | null
}

/**
 * Resolve process display names from their linked skill/goal resources.
 * Replaces UUID-based slugs with human-readable resource names.
 * Mutates rows in place.
 */
export async function resolveProcessDisplayNames(
  resources: ResourcesService,
  rows: ProcessRow[],
): Promise<void> {
  const skillIds = [...new Set(rows.map((r) => r.skill_resource_id).filter(Boolean))] as string[]
  if (skillIds.length === 0) return

  const skills = await resources.findByIds(skillIds)

  if (!skills?.length) return

  const nameMap = new Map(skills.map((s: { id: string; name: string }) => [s.id, s.name]))
  for (const row of rows) {
    if (row.skill_resource_id && nameMap.has(row.skill_resource_id)) {
      row.name = nameMap.get(row.skill_resource_id) ?? row.name
    }
  }
}

const SinceParam = z.string().datetime().optional()

/**
 * Query processes with optional status, created_at, and project filters.
 * If project is provided (a project name), resolves it to a UUID via
 * resources.findByNameAndType and passes the UUID to processes.query() for
 * direct project_id filtering. Returns an empty array if the project is unknown.
 * Returns an array of validated ApiProcess objects.
 */
export async function queryProcesses(
  processes: ProcessesService,
  resources: ResourcesService,
  status: string | string[] | undefined,
  since?: string | undefined,
  project?: string,
): Promise<ApiProcess[]> {
  const validatedSince = SinceParam.parse(since)

  let projectId: string | undefined
  if (project) {
    const projectResource = await resources.findByNameAndType(project, 'project')
    if (!projectResource) return []
    projectId = projectResource.id
  }

  const rows = await processes.query({
    status: status ?? undefined,
    since: validatedSince,
    projectId,
  }) as unknown as ProcessRow[]

  await resolveProcessDisplayNames(resources, rows)
  // postgres.js returns Date objects for timestamp columns; Zod schema expects ISO strings
  return rows.map((row) => {
    const normalized = { ...row }
    for (const key of ['updated_at', 'created_at', 'started_at', 'completed_at'] as const) {
      if (normalized[key] instanceof Date) {
        normalized[key] = (normalized[key] as Date).toISOString()
      }
    }
    return ApiProcessSchema.parse(normalized)
  })
}
