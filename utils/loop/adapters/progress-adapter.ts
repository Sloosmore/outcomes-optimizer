import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

/**
 * Interface for calculating process progress (0.0–1.0) from workspace state.
 * Returns null if progress cannot be determined.
 */
export interface ProgressAdapter {
  calculateProgress(workspaceDir: string): number | null
}

/**
 * Reads workspace/state.json and calculates progress as:
 * stories_passed.length / active_prd.stories.length
 *
 * Returns null if:
 * - state.json is missing or unreadable
 * - JSON is malformed
 * - active_prd is not set or not found in prds
 * - stories array is missing or empty (avoids division by zero)
 */
export class StoryProgressAdapter implements ProgressAdapter {
  calculateProgress(workspaceDir: string): number | null {
    const stateFile = resolve(workspaceDir, 'state.json')
    if (!existsSync(stateFile)) return null

    let state: unknown
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf-8'))
    } catch {
      return null
    }

    if (typeof state !== 'object' || state === null) return null

    const s = state as Record<string, unknown>
    const activePrdKey = s.active_prd
    if (typeof activePrdKey !== 'string') return null
    // Prevent path traversal — activePrdKey is agent-authored but must not escape workspaceDir
    if (!/^[\w-]+$/.test(activePrdKey)) return null

    // Find active PRD - look in both nested prds map and top-level prd-NNN.json convention
    // The state.json stores PRD stories inline in a prds map OR we need to read the prd file
    // Check prd-NNN.json file first (that's where stories are stored)
    const prdFile = resolve(workspaceDir, `${activePrdKey}.json`)
    let stories: unknown[]
    let storiesPassed: unknown[]

    if (existsSync(prdFile)) {
      let prd: unknown
      try {
        prd = JSON.parse(readFileSync(prdFile, 'utf-8'))
      } catch {
        return null
      }
      if (typeof prd !== 'object' || prd === null) return null
      const p = prd as Record<string, unknown>
      stories = Array.isArray(p.stories) ? p.stories : []
    } else {
      // Fall back to prds map in state.json
      const prds = s.prds
      if (typeof prds !== 'object' || prds === null) return null
      const activePrd = (prds as Record<string, unknown>)[activePrdKey]
      if (typeof activePrd !== 'object' || activePrd === null) return null
      const prdData = activePrd as Record<string, unknown>
      stories = Array.isArray(prdData.stories) ? prdData.stories : []
    }

    if (stories.length === 0) return null

    // stories_passed is in the prds map in state.json
    const prds = s.prds
    if (typeof prds === 'object' && prds !== null) {
      const activePrd = (prds as Record<string, unknown>)[activePrdKey]
      if (typeof activePrd === 'object' && activePrd !== null) {
        storiesPassed = Array.isArray((activePrd as Record<string, unknown>).stories_passed)
          ? ((activePrd as Record<string, unknown>).stories_passed as unknown[])
          : []
      } else {
        storiesPassed = []
      }
    } else {
      storiesPassed = []
    }

    return Math.min(1, storiesPassed.length / stories.length)
  }
}
