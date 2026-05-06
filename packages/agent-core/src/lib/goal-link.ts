import { getAdapter } from './adapter-factory.js'

const TYPE_PREFIXES = ['user', 'agent'] as const

/**
 * Creates a 'runs' link from a named agent/user to a skill resource.
 * Looks up the assignment resource by name (pre-existing, always in scope),
 * then uses createResourceLinkById to avoid scope-filter timing issues with
 * newly-created skill resources.
 *
 * If assignment already contains a colon (e.g. "user:stan"), it is looked up
 * directly. If not found, an error is thrown.
 *
 * If assignment has no colon (e.g. "stan"), a prefix search is attempted using
 * the common type prefixes (user:, agent:). If exactly one match is found it is
 * used transparently. If multiple match, an ambiguous-assignment error is thrown.
 * If none match, an actionable not-found error is thrown.
 */
export async function goalLink(skillResourceId: string, assignment: string): Promise<void> {
  const adapter = getAdapter()

  if (assignment.includes(':')) {
    // Already prefixed — use existing exact-lookup behaviour.
    const assignmentResource = await adapter.getResource(assignment)
    if (!assignmentResource) {
      throw new Error(`Assignment resource not found: ${assignment}`)
    }
    await adapter.createResourceLinkById(assignmentResource.id, skillResourceId, 'runs')
    return
  }

  // Try exact lookup first (handles resources whose name happens to have no prefix).
  const direct = await adapter.getResource(assignment)
  if (direct) {
    await adapter.createResourceLinkById(direct.id, skillResourceId, 'runs')
    return
  }

  // No exact match — probe common type prefixes in parallel.
  const prefixResults = await Promise.all(
    TYPE_PREFIXES.map(async (prefix) => {
      const prefixed = `${prefix}:${assignment}`
      const resource = await adapter.getResource(prefixed)
      return resource ? { name: prefixed, id: resource.id } : null
    })
  )
  const candidates = prefixResults.filter((r): r is NonNullable<typeof r> => r !== null)

  if (candidates.length === 1) {
    await adapter.createResourceLinkById(candidates[0].id, skillResourceId, 'runs')
    return
  }

  if (candidates.length > 1) {
    throw new Error(
      `Ambiguous assignment '${assignment}': multiple resources found. Specify one explicitly: ${candidates.map((c) => c.name).join(', ')}`
    )
  }

  const tried = TYPE_PREFIXES.map((p) => `${p}:${assignment}`).join(', ')
  throw new Error(
    `Assignment resource not found: '${assignment}'. Tried: ${tried}. Use 'duoidal search ${assignment}' to find the resource.`
  )
}
