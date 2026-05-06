import { getAdapter } from './adapter-factory.js'
import { getLocalSubUnchecked } from './identity.js'

/**
 * Returns the current user's first project ID, or null if none exist.
 * Exported independently — no cross-imports to goal-upload, goal-link, or dispatch-config.
 */
export async function projectResolve(): Promise<string | null> {
  const sub = getLocalSubUnchecked()
  if (!sub) return null

  const adapter = getAdapter()
  const projects = await adapter.listProjectsForUser(sub)
  return projects.length > 0 ? projects[0].id : null
}
