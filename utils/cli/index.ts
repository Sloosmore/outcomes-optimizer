import { homedir } from 'os'
import { resolve, isAbsolute } from 'path'
import { loadConfig } from '../config/index.js'
import type { CLIAdapter } from '../config/types.js'
import type { CLITarget, CLIFactoryOptions } from './types.js'
import { createClaudeCodeTarget } from './adapters/claude-code/index.js'
import { createClaudeAgentSdkTarget } from './adapters/claude-agent-sdk/index.js'
import { createCodexTarget } from './adapters/codex/index.js'
import { createMockTarget } from './adapters/mock/index.js'

function resolveBaseDir(workingDir: string | undefined): string {
  if (workingDir === undefined) {
    return homedir()
  }
  if (isAbsolute(workingDir)) {
    return workingDir
  }

  // Resolve relative path and validate it doesn't escape workspace
  const workspace = process.cwd()
  const resolved = resolve(workspace, workingDir)

  if (!resolved.startsWith(workspace)) {
    throw new Error(
      `workingDir cannot escape workspace. ` +
      `Path '${workingDir}' resolves to '${resolved}', ` +
      `which is outside workspace '${workspace}'`
    )
  }

  return resolved
}

const adapters: Record<CLIAdapter, (options: CLIFactoryOptions) => CLITarget> = {
  'claude-code': createClaudeCodeTarget,
  'claude-agent-sdk': createClaudeAgentSdkTarget,
  'codex': createCodexTarget,
  'mock': createMockTarget,
}

export function getCLITarget(adapterOverride?: CLIAdapter): CLITarget {
  const config = loadConfig()
  const adapter = adapterOverride ?? config.cli.adapter
  const factory = adapters[adapter]

  const baseDir = resolveBaseDir(config.cli.workingDir)

  return factory({ baseDir })
}

export type { CLITarget, CLIOutput, PreflightHook, PreflightContext, PostflightHook, PostflightContext } from './types.js'

/**
 * Error thrown when a preflight hook fails.
 */
export class PreflightError extends Error {
  constructor(
    public readonly hookName: string,
    public readonly cause: Error
  ) {
    super(`Preflight hook "${hookName}" failed: ${cause.message}`)
    this.name = 'PreflightError'
  }
}

/**
 * Run all preflight hooks for a target.
 * Hooks run sequentially and we wait for each to complete.
 * Context is frozen to prevent hooks from corrupting state for subsequent hooks.
 * Throws PreflightError if any hook fails.
 */
export async function runPreflight(target: CLITarget): Promise<void> {
  // Freeze context to prevent mutation by hooks
  const context = Object.freeze({
    adapter: target.name,
    configDir: target.configDir,
    workingDir: target.workingDir,
    skillsDir: target.skillsDir,
  })

  for (const hook of target.preflight) {
    try {
      await hook.run(context)
    } catch (err) {
      throw new PreflightError(
        hook.name,
        err instanceof Error ? err : new Error(String(err))
      )
    }
  }
}

/**
 * Error thrown when a postflight hook fails.
 */
export class PostflightError extends Error {
  constructor(
    public readonly hookName: string,
    public readonly cause: Error
  ) {
    super(`Postflight hook "${hookName}" failed: ${cause.message}`)
    this.name = 'PostflightError'
  }
}

/**
 * Context for postflight execution
 */
export interface PostflightInput {
  sessionId: string
  success: boolean
  cost?: number
  durationMs?: number
}

/**
 * Run all postflight hooks for a target.
 * Hooks run sequentially after CLI execution completes.
 * Errors are logged but don't throw by default (postflight is best-effort).
 */
export async function runPostflight(
  target: CLITarget,
  input: PostflightInput,
  options?: { throwOnError?: boolean }
): Promise<void> {
  const context = Object.freeze({
    adapter: target.name,
    configDir: target.configDir,
    workingDir: target.workingDir,
    skillsDir: target.skillsDir,
    sessionId: input.sessionId,
    success: input.success,
    cost: input.cost,
    durationMs: input.durationMs,
  })

  for (const hook of target.postflight) {
    try {
      await hook.run(context)
    } catch (err) {
      const error = new PostflightError(
        hook.name,
        err instanceof Error ? err : new Error(String(err))
      )
      if (options?.throwOnError) {
        throw error
      }
      console.error(`[postflight] ${error.message}`)
    }
  }
}
