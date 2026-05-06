import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from '@skill-networks/logger'
import { supabase } from '../lib/supabase.js'
import { createSupabaseStorageAdapter } from '@skill-networks/database/storage'
import type { SkillErrorResponse } from '../../contracts/skills.js'

const logger = createLogger('agent-livestream:skills')
const __dirname = dirname(fileURLToPath(import.meta.url))

function loadSkillNames(): ReadonlyArray<string> {
  const manifestPath = join(__dirname, '../../../../packages/duoidal-cli/skills.manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { distributable: string[] }
  logger.info(`Loaded ${manifest.distributable.length} valid skill names from manifest`)
  return manifest.distributable
}
const VALID_SKILL_NAMES: ReadonlyArray<string> = loadSkillNames()

export const skillsRouter = new Hono()

const storage = createSupabaseStorageAdapter(supabase)

skillsRouter.get('/:name', async (c) => {
  const name = c.req.param('name')
  if (!VALID_SKILL_NAMES.includes(name)) {
    return c.json<SkillErrorResponse>({ error: 'Skill not found' }, 404)
  }
  try {
    const buffer = await storage.download('bundled-skills', `${name}.tar.gz`)
    return new Response(new Uint8Array(buffer), {
      headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(buffer.byteLength) },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('not found') || msg.includes('404')) return c.json<SkillErrorResponse>({ error: 'Skill not found' }, 404)
    return c.json<SkillErrorResponse>({ error: 'Storage error' }, 500)
  }
})
