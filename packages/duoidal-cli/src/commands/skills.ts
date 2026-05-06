import { Command } from 'commander'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SKILLS_JSON_PATH, SKILLS_DIR } from '../lib/config.js'

// ── Types ──────────────────────────────────────────────────────────────────

interface SkillEntry {
  name: string
  source: string
  installedAt: string
}

interface SkillsRegistry {
  skills: SkillEntry[]
}

interface GitHubFileResponse {
  name: string
  content: string
  encoding: string
}

interface GitHubDirEntry {
  name: string
  type: string
  download_url: string
}

// ── Registry I/O ──────────────────────────────────────────────────────────

function readRegistry(): SkillsRegistry {
  try {
    return JSON.parse(fs.readFileSync(SKILLS_JSON_PATH, 'utf-8')) as SkillsRegistry
  } catch {
    return { skills: [] }
  }
}

function writeRegistry(registry: SkillsRegistry): void {
  fs.mkdirSync(path.dirname(SKILLS_JSON_PATH), { recursive: true })
  const tmpPath = SKILLS_JSON_PATH + '.tmp'
  fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2), { mode: 0o600 })
  fs.renameSync(tmpPath, SKILLS_JSON_PATH)
}

// ── GitHub fetch helpers ──────────────────────────────────────────────────

function githubHeaders(): Record<string, string> {
  const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN']
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

async function fetchGitHubFile(owner: string, repo: string, filePath: string): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`
  const res = await fetch(url, {
    headers: githubHeaders(),
  })

  if (!res.ok) {
    throw new GitHubFetchError(`GitHub returned ${res.status} for ${url}`, res.status)
  }

  const data = (await res.json()) as GitHubFileResponse
  return Buffer.from(data.content, 'base64').toString('utf-8')
}

async function fetchGitHubDir(owner: string, repo: string, dirPath: string): Promise<GitHubDirEntry[] | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}`
  const res = await fetch(url, {
    headers: githubHeaders(),
  })

  if (!res.ok) {
    if (res.status === 404) return null
    throw new GitHubFetchError(`GitHub returned ${res.status} for ${url}`, res.status)
  }

  return (await res.json()) as GitHubDirEntry[]
}

async function fetchRawUrl(url: string): Promise<string> {
  if (!url.startsWith('https://raw.githubusercontent.com/')) {
    throw new Error(`Unexpected download URL origin: ${url}`)
  }
  const res = await fetch(url, { headers: githubHeaders() })
  if (!res.ok) {
    throw new GitHubFetchError(`Fetch returned ${res.status} for ${url}`, res.status)
  }
  return res.text()
}

class GitHubFetchError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
    this.name = 'GitHubFetchError'
  }
}

// ── Atomic directory write ────────────────────────────────────────────────

/**
 * Atomically move a temp directory to the final destination.
 * Falls back to copy+delete if rename fails with EXDEV (cross-device link).
 */
function atomicMoveDir(src: string, dest: string): void {
  // Remove existing destination if present
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true })
  }

  try {
    fs.renameSync(src, dest)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      // Cross-device: copy then delete
      copyDir(src, dest)
      fs.rmSync(src, { recursive: true, force: true })
    } else {
      throw err
    }
  }
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

// ── Command implementation ────────────────────────────────────────────────

export function skillsCommand(): Command {
  const skills = new Command('skills')
  skills.description('Manage installed skills')

  // ── skills add <owner/repo> ────────────────────────────────────────────

  skills
    .command('add <repo>')
    .description('Install a skill from a GitHub repository (format: owner/repo)')
    .action(async (repoArg: string) => {
      const parts = repoArg.split('/')
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        console.error('Error: repo must be in "owner/repo" format')
        process.exit(1)
      }

      const [owner, repo] = parts as [string, string]
      const skillName = repo

      const SAFE_NAME = /^[a-zA-Z0-9_.-]+$/
      if (!SAFE_NAME.test(owner) || !SAFE_NAME.test(skillName)) {
        console.error('Error: owner and repo must contain only alphanumeric characters, hyphens, underscores, or dots')
        process.exit(1)
      }

      // ── Phase 1: Fetch all content from GitHub (no disk writes yet) ──

      let skillMdContent: string
      try {
        skillMdContent = await fetchGitHubFile(owner, repo, 'SKILL.md')
      } catch (err) {
        if (err instanceof GitHubFetchError) {
          console.error(`Error: Could not fetch SKILL.md from ${owner}/${repo} (HTTP ${err.status})`)
        } else {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
        }
        process.exit(1)
      }

      // Fetch references/ directory (may not exist)
      let refEntries: GitHubDirEntry[] | null = null
      const refContents = new Map<string, string>()

      try {
        refEntries = await fetchGitHubDir(owner, repo, 'references')
        if (refEntries) {
          const fileEntries = refEntries.filter(e => e.type === 'file' && e.download_url)
          const fetched = await Promise.all(
            fileEntries.map(async (entry) => ({
              name: entry.name,
              content: await fetchRawUrl(entry.download_url),
            }))
          )
          for (const { name, content } of fetched) {
            refContents.set(name, content)
          }
        }
      } catch (err) {
        if (err instanceof GitHubFetchError) {
          console.error(`Error fetching references: ${err.message}`)
        } else {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
        }
        process.exit(1)
      }

      // ── Phase 2: Write to a temp dir (atomic) ────────────────────────

      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), `duoidal-skill-${skillName}-`))
      try {
        // Write SKILL.md
        fs.writeFileSync(path.join(tmpBase, 'SKILL.md'), skillMdContent, 'utf-8')

        // Write references
        if (refEntries && refContents.size > 0) {
          const refsDir = path.join(tmpBase, 'references')
          fs.mkdirSync(refsDir, { recursive: true })
          for (const [name, content] of refContents) {
            fs.writeFileSync(path.join(refsDir, name), content, 'utf-8')
          }
        }

        // ── Phase 3: Move temp dir to final location (atomic) ──────────

        const finalSkillDir = path.join(SKILLS_DIR, skillName)
        fs.mkdirSync(SKILLS_DIR, { recursive: true })
        atomicMoveDir(tmpBase, finalSkillDir)
      } catch (err) {
        // Clean up temp dir on failure
        fs.rmSync(tmpBase, { recursive: true, force: true })
        console.error(`Error writing skill files: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }

      // ── Phase 4: Update skills.json atomically ────────────────────────

      const registry = readRegistry()
      // Remove existing entry with same name (idempotent)
      const filtered = registry.skills.filter(s => s.name !== skillName)
      filtered.push({
        name: skillName,
        source: `https://github.com/${owner}/${repo}`,
        installedAt: new Date().toISOString(),
      })
      try {
        writeRegistry({ skills: filtered })
      } catch (err) {
        console.error(`Error updating skills.json: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }

      console.log(`Installed skill: ${skillName} from https://github.com/${owner}/${repo}`)
    })

  // ── skills list ──────────────────────────────────────────────────────

  skills
    .command('list')
    .description('List installed skills')
    .action(() => {
      const registry = readRegistry()
      if (registry.skills.length === 0) {
        console.log('No skills installed.')
        return
      }
      for (const skill of registry.skills) {
        console.log(`${skill.name}  ${skill.source}`)
      }
    })

  // ── skills remove <name> ──────────────────────────────────────────────

  skills
    .command('remove <name>')
    .description('Remove an installed skill')
    .action((name: string) => {
      const SAFE_NAME = /^[a-zA-Z0-9_.-]+$/
      if (!SAFE_NAME.test(name)) {
        console.error('Error: invalid skill name — only alphanumeric, hyphens, underscores, or dots are allowed')
        process.exit(1)
      }

      const registry = readRegistry()
      const entry = registry.skills.find(s => s.name === name)
      if (!entry) {
        console.error(`Error: skill '${name}' is not installed`)
        process.exit(1)
      }

      // Remove directory
      const skillDir = path.join(SKILLS_DIR, name)
      if (fs.existsSync(skillDir)) {
        fs.rmSync(skillDir, { recursive: true, force: true })
      }

      // Update registry
      const updated = registry.skills.filter(s => s.name !== name)
      writeRegistry({ skills: updated })

      console.log(`Removed skill: ${name}`)
    })

  return skills
}
