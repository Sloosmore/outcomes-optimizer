import { Command } from 'commander'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createLogger } from '@skill-networks/logger'
import { getSupabaseUrl } from '@skill-networks/database/constants'

const logger = createLogger('agent-core')

// Resolve the path to the execute-action runner script relative to this compiled file.
// __dirname in ESM: dirname(fileURLToPath(import.meta.url))
// Compiled location: packages/agent-core/dist/commands/action.js
// Target:           utils/database/actions/execute-action.ts (workspace root)
function getWorkspaceRoot(): string {
  const thisFile = fileURLToPath(import.meta.url)
  // dist/commands/action.js → go up 4 levels: dist → agent-core → packages → workspace root
  // dist/commands/action.js → dist/commands → dist → agent-core → packages → workspace-root
  return resolve(dirname(thisFile), '..', '..', '..', '..')
}

function createSupabaseClientArgs(): { url: string; key: string } {
  const url = getSupabaseUrl()
  const key =
    process.env.SUPABASE_ANON_KEY ??
    process.env.SUPABASE_KEY ??
    process.env.SUPABASE_SERVICE_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key)
    throw new Error(
      'SUPABASE_ANON_KEY (or SUPABASE_KEY / SUPABASE_SERVICE_KEY / SUPABASE_SERVICE_ROLE_KEY) environment variable is not set'
    )
  return { url, key }
}

export function actionCommand(): Command {
  const cmd = new Command('action').description('Execute registered actions')

  cmd
    .command('execute <actionName> <jsonInput>')
    .description('Execute a named action with a JSON input payload')
    .action(async (actionName: string, jsonInput: string) => {
      let input: Record<string, unknown>
      try {
        input = JSON.parse(jsonInput) as Record<string, unknown>
      } catch {
        logger.error(`Invalid JSON input: ${jsonInput}`)
        process.exitCode = 1
        return
      }

      try {
        // Validate env vars before spawning
        createSupabaseClientArgs()
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
        return
      }

      const workspaceRoot = getWorkspaceRoot()
      const runnerPath = resolve(workspaceRoot, 'packages', 'database', 'src', 'actions', 'execute-action-runner.ts')

      const result = spawnSync(
        'npx',
        ['tsx', runnerPath, actionName, JSON.stringify(input)],
        {
          cwd: workspaceRoot,
          env: process.env,
          encoding: 'utf-8',
        }
      )

      if (result.error) {
        logger.error(`Failed to spawn runner: ${result.error.message}`)
        process.exitCode = 1
        return
      }

      if (result.stderr) {
        process.stderr.write(result.stderr)
      }

      if (result.status !== 0) {
        process.exitCode = result.status ?? 1
        return
      }

      if (result.stdout) {
        process.stdout.write(result.stdout)
      }
    })

  return cmd
}
