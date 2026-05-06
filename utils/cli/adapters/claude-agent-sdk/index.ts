import { resolve } from 'path'
import { homedir } from 'os'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { CLITarget, CLIOutput, CLIFactoryOptions, PreflightHook, PostflightHook, SdkExecutionResult } from '../../types.js'
import { ALLOWED_TOOLS, RATE_LIMIT_PATTERNS } from '../../types.js'
import { CLAUDE_MODEL, CLAUDE_FALLBACK_MODEL } from '../../../types.js'
import { writeSettingsHook } from '../claude-code/preflight.js'
import { EventType } from '@skill-networks/agent-events'
import { getSupabaseServiceKey, getSupabaseUrl } from '@skill-networks/database/constants'

export function emitSdkMessage(
  msg: { type: string; content?: Array<{ type: string; name?: string; id?: string; tool_use_id?: string; input?: unknown; text?: string; is_error?: boolean }>; message?: { content?: Array<{ type: string; name?: string; id?: string; tool_use_id?: string; input?: unknown; text?: string; is_error?: boolean }>; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; is_error?: boolean; result?: string; total_cost_usd?: number; duration_ms?: number; num_turns?: number },
  emitter: { emit: (row: object) => void },
  ctx: { processId: string; processName: string; resourceId: string | null }
): void {
  if (msg.type === 'assistant') {
    const usage = msg.message?.usage ?? msg.usage
    if (usage && (usage.input_tokens != null || usage.output_tokens != null)) {
      const total = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
      emitter.emit({
        source: EventType.TOKEN_USAGE,
        payload: {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          total_tokens: total,
        },
        process_id: ctx.processId,
        process_name: ctx.processName,
        resource_id: ctx.resourceId,
      })
    }
    // SDK 0.2.79+: SDKAssistantMessage wraps content under msg.message.content (not top-level msg.content)
    const content = msg.message?.content ?? msg.content
    if (!content) return
    for (const block of content) {
      if (block.type === 'tool_use') {
        emitter.emit({
          source: block.name,
          payload: { tool_use_id: block.id, input: block.input },
          process_id: ctx.processId,
          process_name: ctx.processName,
          resource_id: ctx.resourceId,
        })
      } else if (block.type === 'text' && block.text && block.text.trim().length > 0) {
        emitter.emit({
          source: EventType.ASSISTANT,
          payload: { text: block.text.slice(0, 500) },
          process_id: ctx.processId,
          process_name: ctx.processName,
          resource_id: ctx.resourceId,
        })
      } else if (block.type === 'tool_result') {
        emitter.emit({
          source: EventType.TOOL_RESULT,
          payload: { tool_use_id: (block as any).tool_use_id, is_error: (block as any).is_error },
          process_id: ctx.processId,
          process_name: ctx.processName,
          resource_id: ctx.resourceId,
        })
      }
    }
  } else if (msg.type === 'result') {
    emitter.emit({
      source: msg.is_error ? EventType.RESULT_ERROR : EventType.RESULT_SUCCESS,
      payload: { duration_ms: msg.duration_ms, total_cost_usd: msg.total_cost_usd, num_turns: msg.num_turns },
      process_id: ctx.processId,
      process_name: ctx.processName,
      resource_id: ctx.resourceId,
    })
  }
}

let _emitterClient: SupabaseClient | undefined

function createSupabaseEmitter(): { emit: (row: object) => void } | null {
  const url = getSupabaseUrl()
  // Emitter is optional infrastructure — getSupabaseServiceKey() throws when unset,
  // so we catch and disable emission, preserving the previous opt-in behavior.
  let key: string
  try {
    key = getSupabaseServiceKey()
  } catch {
    return null
  }

  if (!_emitterClient) {
    // Use the native (pre-interceptor) fetch if the credential proxy interceptor
    // has patched globalThis.fetch — Supabase has its own auth via SUPABASE_SERVICE_KEY
    // and must not be routed through the credential proxy sidecar.
    const nativeFetch = (globalThis as unknown as { __nativeFetch?: typeof fetch }).__nativeFetch
    _emitterClient = nativeFetch
      ? createClient(url, key, { global: { fetch: nativeFetch } })
      : createClient(url, key)
  }

  const client = _emitterClient
  return {
    emit: (row: object) => {
      void (client.from('agent_events').insert(row) as unknown as Promise<unknown>).then(() => {}).catch((err: unknown) => {
        console.error('[agent-events] emit failed:', err instanceof Error ? err.message : String(err))
      })
    },
  }
}

function matchesRateLimitPattern(text: string | undefined): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  return RATE_LIMIT_PATTERNS.some(pattern => lower.includes(pattern))
}

export function createClaudeAgentSdkTarget(options: CLIFactoryOptions): CLITarget {
  const isHomedir = options.baseDir === homedir()
  const preflight: PreflightHook[] = [writeSettingsHook]
  const postflight: PostflightHook[] = []
  const configDir = resolve(options.baseDir, '.claude')

  const workingDir = isHomedir ? process.cwd() : options.baseDir

  return {
    name: 'claude-agent-sdk',
    configDir,
    skillsDir: resolve(configDir, 'skills'),
    workingDir,
    envVar: 'ANTHROPIC_API_KEY',
    fallbackModel: CLAUDE_FALLBACK_MODEL,

    preflight,
    postflight,

    registerPreflight(hook: PreflightHook): void {
      if (preflight.some(h => h.name === hook.name)) {
        return
      }
      preflight.push(hook)
    },

    registerPostflight(hook: PostflightHook): void {
      if (postflight.some(h => h.name === hook.name)) {
        return
      }
      postflight.push(hook)
    },

    buildCommand(prompt: string): string[] {
      return ['claude-agent-sdk', '--prompt', prompt]
    },

    // parseOutput intentionally omitted — executeQuery is the real path

    validateEnvironment(): void {
      const hasKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN
      const isCI = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true'
      if (!hasKey) {
        if (isCI) {
          throw new Error(
            'Missing Anthropic credentials. Please set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.\n' +
            'You can also run \'claude /login\' to authenticate.'
          )
        }
        console.warn('No ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN set; relying on stored Claude credentials.')
      }
    },

    async executeQuery(prompt: string, _env: NodeJS.ProcessEnv, opts?: { model?: string }): Promise<SdkExecutionResult> {
      // Note: _env is accepted for interface compatibility but the SDK reads from
      // process.env directly. OAuth token routing is handled upstream by the caller.
      const model = opts?.model ?? CLAUDE_MODEL
      const command = ['claude-agent-sdk', '--prompt', prompt]
      const startTime = Date.now()

      try {
        const { query } = await import('@anthropic-ai/claude-agent-sdk')
        const conversation = await query({
          prompt,
          options: {
            cwd: workingDir,
            allowedTools: [...ALLOWED_TOOLS],
            model,
            settingSources: ["project", "user"],
          },
        })

        let result: { session_id?: string; is_error?: boolean; result?: string; total_cost_usd?: number; duration_ms?: number } | undefined

        // Build emission context from env vars
        // IMPORTANT: Each concurrent process MUST run as a separate OS process
        // (not Promise.all in one Node process) because process.env is shared.
        const processId = process.env.EVAL_PROCESS_ID ?? process.env.EVAL_CAMPAIGN_ID
        const resourceId = process.env.EVAL_SKILL_RESOURCE_ID ?? null
        const emitter = processId ? createSupabaseEmitter() : null
        const shouldEmit = !!processId && !!emitter
        const emitCtx = shouldEmit ? {
          processId: processId!,
          processName: process.env.EVAL_PROCESS ?? process.env.EVAL_CAMPAIGN_NAME ?? 'unknown',
          resourceId,
        } : null

        for await (const msg of conversation) {
          // Emit events for livestream UI (fire-and-forget)
          if (emitter && emitCtx) {
            emitSdkMessage(msg as any, emitter, emitCtx)
          }

          if (msg.type === 'result') {
            result = msg
          }
        }

        if (!result) {
          return {
            command,
            output: {
              sessionId: `sdk-${Date.now()}`,
              success: false,
              error: 'No result message received from SDK',
            },
            durationMs: Date.now() - startTime,
            exitCode: 1,
          }
        }

        return {
          command,
          output: {
            sessionId: result.session_id || `sdk-${Date.now()}`,
            success: !result.is_error,
            result: result.result,
            cost: result.total_cost_usd,
            durationMs: result.duration_ms,
            error: result.is_error ? (result.result || 'Unknown SDK error') : undefined,
          },
          durationMs: Date.now() - startTime,
          exitCode: result.is_error ? 1 : 0,
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        return {
          command,
          output: {
            sessionId: `sdk-${Date.now()}`,
            success: false,
            error: errorMessage,
          },
          durationMs: Date.now() - startTime,
          exitCode: 1,
        }
      }
    },

    isRateLimited(output: CLIOutput, streams?: { stdout: string; stderr: string }): boolean {
      if (matchesRateLimitPattern(output.error)) return true
      if (matchesRateLimitPattern(output.result)) return true
      if (matchesRateLimitPattern(output.rawOutput)) return true
      if (streams) {
        if (matchesRateLimitPattern(streams.stdout)) return true
        if (matchesRateLimitPattern(streams.stderr)) return true
      }
      return false
    },
  }
}
