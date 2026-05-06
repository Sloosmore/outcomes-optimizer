/**
 * CLI entry point for provisioning dispatch environments.
 *
 * Usage:
 *   npx tsx utils/dispatch/provision.ts \
 *     --provision worktree --provision compose \
 *     --slug my-run \
 *     --worktree /tmp/my-run
 *
 * Writes runtime-context.md and .env into the worktree directory,
 * then exits. Teardown runs on SIGTERM/SIGINT if the process is kept alive.
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { ProvisionerRegistry } from './registry.js'
import { ProvisionContext } from './provision-context.js'
import { worktreeProvisioner } from './provisioners/worktree.js'
import { composeProvisioner } from './provisioners/compose.js'

function parseArgs(argv: string[]): {
  provisions: string[]
  slug: string
  worktree: string
  opts: Record<string, string>
} {
  const provisions: string[] = []
  let slug = ''
  let worktree = ''
  const opts: Record<string, string> = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--provision' && argv[i + 1]) {
      provisions.push(argv[++i])
    } else if (arg === '--slug' && argv[i + 1]) {
      slug = argv[++i]
    } else if (arg === '--worktree' && argv[i + 1]) {
      worktree = argv[++i]
    } else if (arg === '--repo' && argv[i + 1]) {
      opts['repo'] = argv[++i]
    } else if (arg === '--base-dir' && argv[i + 1]) {
      opts['base-dir'] = argv[++i]
    } else if (arg === '--skill-resource-id' && argv[i + 1]) {
      opts['skill-resource-id'] = argv[++i]
    } else if (arg === '--run-type' && argv[i + 1]) {
      opts['run-type'] = argv[++i]
    } else if (arg === '--branch' && argv[i + 1]) {
      opts['branch'] = argv[++i]
    } else if (arg === '--skip-fetch') {
      opts['skip-fetch'] = 'true'
    } else if (arg === '--parent-process-id' && argv[i + 1]) {
      opts['parent-process-id'] = argv[++i]
    } else if (arg === '--project-id' && argv[i + 1]) {
      opts['project-id'] = argv[++i]
    } else if (arg === '--build-local') {
      opts['build-local'] = 'true'
    } else if (arg === '--skip-build-local') {
      opts['skip-build-local'] = 'true'
    }
  }

  if (!slug) {
    console.error('Error: --slug is required')
    process.exit(1)
  }
  if (provisions.length === 0) {
    console.error('Error: at least one --provision <name> is required')
    process.exit(1)
  }

  // CRITICAL: worktree provisioner reads opts['worktree'] to detect in-place mode
  opts['worktree'] = worktree

  return { provisions, slug, worktree, opts }
}

export async function main(): Promise<void> {
  const { provisions, slug, worktree, opts } = parseArgs(process.argv.slice(2))

  const registry = new ProvisionerRegistry()
  registry.register(worktreeProvisioner)
  registry.register(composeProvisioner)

  const ctx = new ProvisionContext()
  await registry.run(ctx, provisions, slug, opts)

  // Write .env and provision-output.env (if worktree path was set)
  if (ctx.worktreePath) {
    fs.mkdirSync(ctx.worktreePath, { recursive: true })

    // Atomically write all env vars to <worktreePath>/.env
    ctx.writeEnv()

    // Write runtime-context.md
    const contextPath = path.join(ctx.worktreePath, 'runtime-context.md')
    fs.writeFileSync(contextPath, ctx.contextFragments.join('\n\n'), { encoding: 'utf-8', mode: 0o600 })
  }

  // Write provision-output.env thin pointer (WORKTREE_PATH only).
  // Written inside the worktree dir (or <base-dir>/<slug> if worktreePath not set)
  // so concurrent dispatches cannot overwrite each other's file.
  const outputBase = opts['base-dir'] || process.cwd()
  const outputDir = ctx.worktreePath || path.join(outputBase, slug)
  fs.mkdirSync(outputDir, { recursive: true })
  const outputEnvPath = path.join(outputDir, 'provision-output.env')
  fs.writeFileSync(outputEnvPath, ctx.toShellEnv(), { encoding: 'utf-8', mode: 0o600 })

  // Set up teardown on exit signals
  const handleExit = async () => {
    try {
      await registry.teardown(ctx, provisions, slug)
    } catch (err) {
      console.error('Teardown error:', err)
    }
    process.exit(0)
  }

  process.on('SIGTERM', handleExit)
  process.on('SIGINT', handleExit)

  // Exit cleanly after provisioning is complete.
  // Without this, the Supabase realtime subscription created by createWatchdog keeps
  // the Node.js event loop alive indefinitely, blocking dispatch.ts which awaits
  // provision.ts via execFileAsync. The SIGTERM/SIGINT teardown handlers above are
  // unreachable once we exit here; teardown for worktrees is handled by the agent loop.
  process.exit(0)
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message || err)
    process.exit(1)
  })
}
