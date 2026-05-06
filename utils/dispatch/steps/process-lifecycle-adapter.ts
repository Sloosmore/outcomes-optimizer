/**
 * Adapter for managing process lifecycle transitions via the duoidal CLI (SKILL_NETWORKS_CLI).
 *
 * Encapsulates the processId at construction time so callers invoke
 * onStarted/onCompleted/onFailed without passing an id each time.
 */

import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { getCliCommand } from '../../cli-prefix.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class ProcessLifecycleAdapter {
  readonly processId: string

  constructor(processId: string) {
    if (!UUID_RE.test(processId)) {
      throw new Error(`Invalid processId: expected UUID, got "${processId}"`)
    }
    this.processId = processId
  }

  onStarted(): void {
    const [bin, prefixArgs] = getCliCommand()
    execFileSync(bin, [...prefixArgs, 'process', 'active', '--id', this.processId], {
      stdio: 'inherit',
    })
  }

  onCompleted(): void {
    const [bin, prefixArgs] = getCliCommand()
    execFileSync(bin, [...prefixArgs, 'process', 'complete', '--id', this.processId], {
      stdio: 'inherit',
    })
  }

  onFailed(reason: string): void {
    const [bin, prefixArgs] = getCliCommand()
    execFileSync(
      bin,
      [...prefixArgs, 'process', 'fail', '--id', this.processId, '--reason', reason],
      { stdio: 'inherit' },
    )
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const subcommand = args[0]
  const parsed: Record<string, string> = {}
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = args[i + 1]
      if (value !== undefined && !value.startsWith('--')) {
        parsed[key] = value
        i++
      }
    }
  }
  if (!parsed['id']) {
    console.error('Error: --id is required')
    process.exit(1)
  }
  const adapter = new ProcessLifecycleAdapter(parsed['id'])
  if (subcommand === 'started') adapter.onStarted()
  else if (subcommand === 'completed') adapter.onCompleted()
  else if (subcommand === 'failed') adapter.onFailed(parsed['reason'] ?? 'unknown')
  else { console.error(`Unknown subcommand: ${subcommand}`); process.exit(1) }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
