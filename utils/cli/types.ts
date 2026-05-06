import type { CLIAdapter } from '../config/types.js'

/** Patterns that indicate a rate-limit, model overload, or quota/billing exhaustion. */
export const RATE_LIMIT_PATTERNS = [
  'overloaded',
  'rate_limit',
  'rate limit',
  'too many requests',
  '429',
  '529',
  'capacity',
  'hit your limit',
  'resets',
  'insufficient_quota',
  'exceeded your current quota',
  'quota_exceeded',
  'billing_hard_limit',
  'model_cooldown',
  'cooling down',
] as const

export const ALLOWED_TOOLS = [
  'Write', 'Edit', 'Read', 'Bash', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Agent', 'Skill',
  'TodoWrite', 'TodoRead', 'NotebookEdit', 'NotebookRead', 'mcp__*',
] as const

export interface CLIFactoryOptions {
  baseDir: string
}

/**
 * Context passed to preflight hooks before CLI invocation
 */
export interface PreflightContext {
  /** Adapter name (claude-code, codex, mock) - hook uses this to decide where to write */
  adapter: string
  /** Base config directory (e.g., .claude/ or .codex/) */
  configDir: string
  workingDir: string
  skillsDir: string
}

/**
 * Context passed to postflight hooks after CLI invocation
 */
export interface PostflightContext extends PreflightContext {
  /** Session ID from the CLI execution */
  sessionId: string
  /** Whether the execution succeeded */
  success: boolean
  /** Cost of the execution (if available) */
  cost?: number
  /** Duration in milliseconds */
  durationMs?: number
}

/**
 * Hook that runs before CLI invocation.
 * Runs every time - hook handles its own idempotency logic.
 */
export interface PreflightHook {
  name: string
  run(context: PreflightContext): Promise<void>
}

/**
 * Hook that runs after CLI invocation.
 * Used for trace collection, metrics, cleanup, etc.
 */
export interface PostflightHook {
  name: string
  run(context: PostflightContext): Promise<void>
}

/**
 * Minimal execution result shape returned by executeQuery.
 * Duplicated here to avoid a circular dependency with utils/run/types.ts,
 * which imports from this file.
 */
export interface SdkExecutionResult {
  command: string[]
  output: CLIOutput
  durationMs: number
  exitCode: number
}

export interface CLITarget {
  name: CLIAdapter
  /** Base config directory (e.g., .claude/ or .codex/) */
  configDir: string
  /** Skills directory - derived from configDir (e.g., .claude/skills/) */
  skillsDir: string
  workingDir: string
  envVar: string

  /** Preflight hooks - run sequentially before CLI invocation */
  preflight: PreflightHook[]
  /** Postflight hooks - run sequentially after CLI invocation */
  postflight: PostflightHook[]

  /** Register a preflight hook */
  registerPreflight(hook: PreflightHook): void
  /** Register a postflight hook */
  registerPostflight(hook: PostflightHook): void

  /** Model to try if the primary model is rate-limited */
  fallbackModel?: string

  buildCommand(prompt: string): string[]
  /**
   * Parse raw stdout from the CLI process into a structured CLIOutput.
   * Optional: adapters that provide their own executeQuery do not need this.
   */
  parseOutput?(stdout: string): CLIOutput
  validateEnvironment(): void

  /**
   * Alternative to buildCommand + parseOutput: drive execution entirely via
   * the SDK (e.g. @anthropic-ai/claude-code) instead of spawning a process.
   * When present, the executor should prefer this over spawnCommand.
   * @param options.model - Override the model used for this query (e.g. for fallback retries)
   */
  executeQuery?(prompt: string, env: NodeJS.ProcessEnv, options?: { model?: string }): Promise<SdkExecutionResult>

  /**
   * Determine whether an execution result represents a rate-limit condition.
   * When absent the executor falls back to its built-in pattern matching.
   */
  isRateLimited?(output: CLIOutput, streams?: { stdout: string; stderr: string }): boolean
}

export interface CLIOutput {
  sessionId: string
  success: boolean
  result?: string
  cost?: number
  error?: string
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  }
  durationMs?: number
  rawOutput?: string  // Only included on error for debugging
}
