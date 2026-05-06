import { createClient } from '@supabase/supabase-js'
import { createSupabaseStorageAdapter } from '@skill-networks/database/storage'
import { execSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_URL) {
  console.error('ERROR: SUPABASE_URL env var is required')
  process.exit(1)
}
if (!SUPABASE_SERVICE_KEY) {
  console.error('ERROR: SUPABASE_SERVICE_KEY env var is required')
  process.exit(1)
}

const BUCKET = 'bundled-skills'
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/duoidal-cli/skills.manifest.json'), 'utf8')) as { distributable: string[] }
const SKILLS = manifest.distributable

function getCommitSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    console.warn('WARNING: could not determine commit SHA (git unavailable, GITHUB_SHA not set). Metadata will be missing provenance.')
    return 'unknown'
  }
}

async function main(): Promise<void> {
  const client = createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!)
  const storage = createSupabaseStorageAdapter(client)
  const commitSha = getCommitSha()

  console.log(`Publishing ${SKILLS.length} skills at commit_sha=${commitSha}`)

  for (const skillName of SKILLS) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skillName)) {
      throw new Error(`Invalid skill name in manifest: "${skillName}"`)
    }
    const tmpDir = mkdtempSync(join(tmpdir(), 'publish-skills-'))
    const archivePath = join(tmpDir, `${skillName}.tar.gz`)

    try {
      console.log(`Archiving ${skillName}...`)
      execFileSync('tar', ['-czf', archivePath, '-C', join(REPO_ROOT, 'skills'), skillName], {
        stdio: 'inherit',
      })

      console.log(`Uploading ${skillName}.tar.gz to bucket '${BUCKET}'...`)
      const data = readFileSync(archivePath)
      await storage.upload(BUCKET, `${skillName}.tar.gz`, data, {
        contentType: 'application/gzip',
        metadata: { commitSha },
      })

      console.log(`Successfully uploaded ${skillName}.tar.gz`)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  console.log('All skills published successfully.')
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
