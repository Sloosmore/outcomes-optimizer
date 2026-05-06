import fs from 'node:fs'
import path from 'node:path'
import { parseFrontmatter } from './frontmatter.js'
import { getAdapter } from './adapter-factory.js'

export interface GoalUploadResult {
  skillResourceId: string
  slug: string
}

/**
 * Reads a goal file, derives a slug from the heading, and uploads it as a skill resource.
 * Returns the resource ID and slug. Does not create links or dispatch processes.
 *
 * @param epochsOverride - When provided, overrides the epochs value from frontmatter.
 *   Callers that have already resolved epochs (e.g. via CLI flag) should pass the resolved
 *   value to keep the uploaded resource metadata consistent with the actual dispatch count.
 * @param slugOverride - When provided, used as the starting value for the slug instead of
 *   deriving it from the goal title. The override still goes through the same
 *   normalization and validation (lowercase, non-alphanumerics → hyphens, trim hyphens,
 *   truncate to 50 chars, reject empty result), so callers don't need to duplicate that
 *   logic and an invalid override (e.g. all-symbols, too long) is cleaned up the same way.
 * @param options - Optional configuration overrides.
 *   - `pr`: When provided, sets the `pr` field on the uploaded resource config.
 *     When omitted, `pr` is not included in the config at all.
 */
export async function goalUpload(filePath: string, epochsOverride?: number, slugOverride?: string, options?: { pr?: boolean }): Promise<GoalUploadResult> {
  const absolutePath = path.resolve(filePath)

  let content: string
  try {
    content = fs.readFileSync(absolutePath, 'utf-8')
  } catch (err) {
    throw new Error(
      `Could not read goal file at ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // Resolve epochs: use caller-provided override, else parse from frontmatter, else default 10
  let epochs: number
  if (epochsOverride !== undefined) {
    epochs = epochsOverride
  } else {
    const frontmatter = parseFrontmatter(content)
    const rawEpochs = frontmatter['epochs']
    const parsedEpochs = rawEpochs !== undefined ? parseInt(rawEpochs, 10) : NaN
    epochs = Number.isInteger(parsedEpochs) && !isNaN(parsedEpochs) ? parsedEpochs : 10
  }

  // Strip frontmatter block from content before slug extraction
  const frontmatterMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)
  const body = frontmatterMatch ? content.slice(frontmatterMatch[0].length) : content

  // Derive slug from first non-empty line in the body (same logic as execute.ts)
  const lines = body.split('\n')
  const firstNonEmpty = lines.find(l => l.trim().length > 0) ?? ''
  let title = firstNonEmpty
  if (title.startsWith('# Goal:')) {
    title = title.slice('# Goal:'.length).trim()
  } else if (title.startsWith('# ')) {
    title = title.slice(2).trim()
  }

  // slugOverride is a starting value, not a bypass — it still flows through the same
  // normalization as a derived slug so callers don't need to duplicate the logic, and
  // invalid overrides (empty, all-symbols, too long) get cleaned up identically.
  const slug = (slugOverride ?? title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)

  if (!slug) {
    throw new Error(
      `Could not derive a slug from goal file at ${absolutePath}. Ensure the file has a non-empty heading.`
    )
  }

  const adapter = getAdapter()
  const config: { content: string; epochs: number; worktree: boolean; git: boolean; pr?: boolean } = {
    content, epochs, worktree: true, git: true
  }
  if (options?.pr !== undefined) {
    config.pr = options.pr
  }

  const resource = await adapter.addResource(
    `skill/${slug}`,
    'skill',
    config
  )

  return { skillResourceId: resource.id, slug }
}
