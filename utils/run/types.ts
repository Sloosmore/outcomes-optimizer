import type { CLIOutput } from '../cli/types.js'
import type { SyncResult } from '../sync/types.js'

export interface RunInput {
  prompt: string
  /** Override the user skills directory (defaults to ~/.config/duoidal/skills). Useful in tests. */
  userSkillsRoot?: string
}

export interface RunResult {
  sync: SyncResult[]
  execution: ExecutionResult
}

export interface ExecutionResult {
  command: string[]
  output: CLIOutput
  durationMs: number
  exitCode: number
  /** @internal — used by executor for fallback detection, stripped before return */
  _stderr?: string
  /** @internal — used by executor for fallback detection, stripped before return */
  _stdout?: string
}
