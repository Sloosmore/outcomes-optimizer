/**
 * Process lifecycle management for dispatch workflows.
 *
 * Wraps the duoidal CLI (SKILL_NETWORKS_CLI) to init, complete, and sleep processes.
 */

import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { getCliCommand } from '../../cli-prefix.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Initialises a new process via the duoidal CLI and returns the campaign ID (stdout trimmed).
 */
export function initProcess(opts: {
  name: string
  branch: string
  runType: string
  skillResourceId: string
}): string {
  const [bin, prefixArgs] = getCliCommand()
  const output = execFileSync(
    bin,
    [
      ...prefixArgs,
      'process',
      'init',
      '--name',
      opts.name,
      '--branch',
      opts.branch,
      '--run-type',
      opts.runType,
      '--skill-resource-id',
      opts.skillResourceId,
    ],
    { encoding: 'utf8' },
  )
  return output.trim()
}

/**
 * Marks a process complete via the duoidal CLI.
 */
export function completeProcess(opts: { id: string }): void {
  if (!UUID_RE.test(opts.id)) throw new Error(`Invalid process id: "${opts.id}"`)
  const [bin, prefixArgs] = getCliCommand()
  execFileSync(bin, [...prefixArgs, 'process', 'complete', '--id', opts.id], {
    encoding: 'utf8',
    stdio: 'inherit',
  })
}

/**
 * Marks a process as sleeping via the duoidal CLI.
 */
export function sleepProcess(opts: { id: string; interval: string }): void {
  if (!UUID_RE.test(opts.id)) throw new Error(`Invalid process id: "${opts.id}"`)
  const [bin, prefixArgs] = getCliCommand()
  execFileSync(
    bin,
    [...prefixArgs, 'process', 'sleep', '--interval', opts.interval],
    {
      encoding: 'utf8',
      stdio: 'inherit',
      env: { ...process.env, EVAL_PROCESS_ID: opts.id },
    },
  )
}

function main(): void {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help')) {
    console.log(`Usage: process.ts <subcommand> [options]

Subcommands:
  init     --name <name> --branch <branch> --run-type <type> --skill-resource-id <id>
             Initialises a process via agent-core and prints the process ID

  complete --id <process-id>
             Marks a process complete via agent-core

  sleep    --id <process-id> --interval <interval>
             Marks a process sleeping via agent-core`)
    process.exit(0)
  }

  const subcommand = args[0]
  const rest = args.slice(1)

  const parsed: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = rest[i + 1]
      if (value !== undefined && !value.startsWith('--')) {
        parsed[key] = value
        i++
      }
    }
  }

  if (subcommand === 'init') {
    if (!parsed['name'] || !parsed['branch'] || !parsed['run-type'] || !parsed['skill-resource-id']) {
      console.error('Error: --name, --branch, --run-type, and --skill-resource-id are required for init')
      process.exit(1)
    }
    try {
      const id = initProcess({
        name: parsed['name'],
        branch: parsed['branch'],
        runType: parsed['run-type'],
        skillResourceId: parsed['skill-resource-id'],
      })
      console.log(id)
    } catch (err) {
      console.error((err as Error).message)
      process.exit(1)
    }
  } else if (subcommand === 'complete') {
    if (!parsed['id']) {
      console.error('Error: --id is required for complete')
      process.exit(1)
    }
    try {
      completeProcess({ id: parsed['id'] })
    } catch (err) {
      console.error((err as Error).message)
      process.exit(1)
    }
  } else if (subcommand === 'sleep') {
    if (!parsed['id'] || !parsed['interval']) {
      console.error('Error: --id and --interval are required for sleep')
      process.exit(1)
    }
    try {
      sleepProcess({ id: parsed['id'], interval: parsed['interval'] })
    } catch (err) {
      console.error((err as Error).message)
      process.exit(1)
    }
  } else {
    console.error(`Unknown subcommand: ${subcommand}`)
    process.exit(1)
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
