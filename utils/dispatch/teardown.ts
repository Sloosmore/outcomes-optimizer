/**
 * Standalone CLI for stateless provisioner teardown.
 *
 * Usage:
 *   npx tsx utils/dispatch/teardown.ts --slug <slug> --worktree <path> --provision <name> [--provision <name>...]
 *
 * Reads .env from the worktree path to reconstruct a minimal ProvisionContext,
 * then calls each named provisioner's teardown() in its own try/catch.
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { ProvisionContext } from './provision-context.js'
import { teardown as worktreeTeardown } from './provisioners/worktree.js'
import { teardown as composeTeardown } from './provisioners/compose.js'

const KNOWN_PROVISIONERS: Record<string, (ctx: ProvisionContext, slug: string) => Promise<void>> = {
  'worktree': worktreeTeardown,
  'compose': composeTeardown,
}

const USAGE = `Usage: npx tsx utils/dispatch/teardown.ts --slug <slug> --worktree <path> --provision <name> [--provision <name>...]

Options:
  --slug <slug>          Run slug (required)
  --worktree <path>      Path to worktree directory containing .env
  --provision <name>     Provisioner to tear down (repeatable)
  --help                 Show this help message

Known provisioners: ${Object.keys(KNOWN_PROVISIONERS).join(', ')}
`

interface TeardownResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Parse a .env file into key-value pairs, stripping double quotes from values.
 */
function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx)
    let value = trimmed.slice(eqIdx + 1)
    // Strip surrounding double quotes and unescape sequences written by ProvisionContext.quote()
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\(["n$`\\])/g, (_, ch) => {
        switch (ch) {
          case 'n': return '\n'
          case '"': return '"'
          case '$': return '$'
          case '`': return '`'
          case '\\': return '\\'
          default: return ch
        }
      })
    }
    env[key] = value
  }
  return env
}

/**
 * Reconstruct a minimal ProvisionContext from parsed .env values.
 */
function buildContext(env: Record<string, string>): ProvisionContext {
  const ctx = new ProvisionContext()
  if (env.WORKTREE_PATH) ctx.worktreePath = env.WORKTREE_PATH
  if (env.SKILL_RESOURCE_ID) ctx.skillResourceId = env.SKILL_RESOURCE_ID
  if (env.DATABASE_URL) ctx.setEnv('DATABASE_URL', env.DATABASE_URL)
  if (env.DIRECT_URL) ctx.setEnv('DIRECT_URL', env.DIRECT_URL)
  if (env.CREDENTIAL_PROXY_URL) ctx.setEnv('CREDENTIAL_PROXY_URL', env.CREDENTIAL_PROXY_URL)
  if (env.CREDENTIAL_PROXY_PORT) ctx.setEnv('CREDENTIAL_PROXY_PORT', env.CREDENTIAL_PROXY_PORT)
  if (env.DASHBOARD_URL) ctx.setEnv('DASHBOARD_URL', env.DASHBOARD_URL)
  if (env.DASHBOARD_BFF_URL) ctx.setEnv('DASHBOARD_BFF_URL', env.DASHBOARD_BFF_URL)
  if (env.SUPABASE_BRANCH_NAME) ctx.setEnv('SUPABASE_BRANCH_NAME', env.SUPABASE_BRANCH_NAME)
  return ctx
}

/**
 * Parse CLI args into structured form.
 */
function parseArgs(args: string[]): { slug?: string; worktree?: string; provisions: string[]; help: boolean } {
  const result = { slug: undefined as string | undefined, worktree: undefined as string | undefined, provisions: [] as string[], help: false }
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--slug':
        if (i + 1 < args.length) result.slug = args[++i]
        break
      case '--worktree':
        if (i + 1 < args.length) result.worktree = args[++i]
        break
      case '--provision':
        if (i + 1 < args.length) result.provisions.push(args[++i])
        break
      case '--help':
        result.help = true
        break
    }
  }
  return result
}

/**
 * Core teardown logic — testable without process.exit().
 */
export async function runTeardown(args: string[]): Promise<TeardownResult> {
  const parsed = parseArgs(args)

  if (parsed.help) {
    return { exitCode: 0, stdout: USAGE, stderr: '' }
  }

  if (!parsed.slug) {
    return { exitCode: 1, stdout: '', stderr: 'Error: --slug is required.\n\n' + USAGE }
  }

  // Validate provisioner names before doing any work
  for (const name of parsed.provisions) {
    if (!KNOWN_PROVISIONERS[name]) {
      return { exitCode: 1, stdout: '', stderr: `Error: unknown provisioner "${name}". Known: ${Object.keys(KNOWN_PROVISIONERS).join(', ')}` }
    }
  }

  // Read .env if worktree path is provided
  let env: Record<string, string> = {}
  let envWarning = ''
  if (parsed.worktree) {
    const envPath = path.join(parsed.worktree, '.env')
    try {
      const content = fs.readFileSync(envPath, 'utf-8')
      env = parseEnvFile(content)
    } catch {
      envWarning = `Warning: .env not found at ${envPath} — proceeding with empty context\n`
    }
  }

  const ctx = buildContext(env)
  const slug = parsed.slug

  // Run each provisioner teardown in its own try/catch
  for (const name of parsed.provisions) {
    const teardownFn = KNOWN_PROVISIONERS[name]
    try {
      await teardownFn(ctx, slug)
      console.log(`[teardown] ${name} — done`)
    } catch (err) {
      console.log(`[teardown] ${name} — failed:`, (err as Error).message)
    }
  }

  return { exitCode: 0, stdout: '', stderr: envWarning }
}

// CLI entry point
const __filename_resolved = fileURLToPath(import.meta.url)
if (__filename_resolved === process.argv[1]) {
  runTeardown(process.argv.slice(2)).then((result) => {
    if (result.stdout) console.log(result.stdout)
    if (result.stderr) console.error(result.stderr)
    process.exit(result.exitCode)
  })
}
