import { llm, voice } from '../adapters/realtime/livekit-agents.js'
import type { JobContext } from '../adapters/realtime/livekit-agents.js'
import { createLogger } from '@skill-networks/logger'
import { executeClaudeCodeTool } from './claude-code-tool.js'
import { executeShareScreenTool } from './share-screen-tool.js'
import { executeDispatchTool } from './dispatch-tool.js'
import { getAllToolDefs } from '../tools.js'
import type { ToolMeta } from '../tools.js'

function requireTool(map: Map<string, ToolMeta>, name: string): ToolMeta {
  const def = map.get(name)
  if (!def) throw new Error(`voice-tools: '${name}' not found in registry — was it renamed?`)
  return def
}

const toolLogger = createLogger('agent-livestream:tools')

interface VoiceToolContext {
  session: voice.AgentSession
  ctx: JobContext
  chatId: string
  voiceToolJwt: string | undefined
  bffUrl: string
  internalSecret: string | undefined
}

/** Build the three LLM tool wrappers for the voice agent session.
 *  Descriptions are pulled from the canonical registry (server/tools.ts)
 *  so prompt-side wording stays in sync with the chat surface. */
export function createVoiceTools({ session, ctx, chatId, voiceToolJwt, bffUrl, internalSecret }: VoiceToolContext) {
  const defsByName = new Map(getAllToolDefs().map((d) => [d.name, d]))
  const claudeCodeDef = requireTool(defsByName, 'claude_code')
  const shareScreenDef = requireTool(defsByName, 'share_screen')
  const dispatchDef = requireTool(defsByName, 'dispatch')

  const claudeCodeTool = llm.tool({
    description: claudeCodeDef.description,
    parameters: {
      type: 'object' as const,
      properties: { prompt: { type: 'string', description: 'What Claude Code should do in the sandbox' } },
      required: ['prompt'],
    },
    // Canonical LiveKit pattern: await the work and return the actual
    // result. The framework feeds it back as a tool_result so the LLM sees
    // the artifact URL (vs the previous fire-and-forget which returned a
    // placeholder and left the LLM hallucinating "I'll do that now").
    // The LLM produces the verbal acknowledgment in the same assistant
    // turn as the tool_call (system prompt rule #4) — TTS streams it while
    // this await runs in parallel. No runtime-side session.say() needed.
    execute: async ({ prompt }: { prompt: string }): Promise<string> => {
      const startedAt = Date.now()
      toolLogger.info('phase', { phase: 'tool_execute_entered', chatId, t_ms: performance.now() })
      toolLogger.info('claude_code.execute.start', {
        chatId,
        roomName: ctx.room.name,
        jobId: (ctx as unknown as { job?: { id?: string } }).job?.id,
        promptPreview: prompt.slice(0, 200),
        promptLength: prompt.length,
      })
      try {
        const result = await executeClaudeCodeTool({ voiceToolJwt, BFF_URL: bffUrl, prompt, ctx })
        toolLogger.info('phase', {
          phase: 'tool_execute_returned',
          chatId,
          t_ms: performance.now(),
          artifactUrl: result.artifactUrl,
        })
        toolLogger.info('claude_code.execute.done', {
          durationMs: Date.now() - startedAt,
          artifactUrl: result.artifactUrl,
          replyTextLength: result.replyText.length,
        })
        return result.replyText
      } catch (err) {
        const e = err as Error
        toolLogger.error('claude_code.execute.threw', {
          durationMs: Date.now() - startedAt,
          message: e?.message,
          stack: e?.stack,
        })
        throw err
      }
    },
  })

  const shareScreenTool = llm.tool({
    description: shareScreenDef.description,
    parameters: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Optional. The https URL to display. Omit to keep the currently shared artifact and only flip the view via `mode`.' },
        mode: {
          type: 'string',
          enum: ['focus', 'spotlight'],
          description: "Optional view toggle: 'focus' switches to single full-bleed view, 'spotlight' switches to multi-tile Stage Manager view. Omit to preserve the current view.",
        },
      },
      required: [],
    },
    execute: ({ url, mode }: { url?: string; mode?: 'focus' | 'spotlight' }) => {
      void (async () => {
        await executeShareScreenTool({ url, session, ctx, chatId, bffUrl, internalSecret, mode })
      })()
      return Promise.resolve(url ? 'Sharing screen now.' : 'Switching view.')
    },
  })

  const dispatchTool = llm.tool({
    description: dispatchDef.description,
    parameters: {
      type: 'object' as const,
      properties: {
        spec_url: { type: 'string', description: 'URL to a markdown spec describing the task' },
        mode: {
          type: 'string',
          enum: ['focus', 'spotlight'],
          description: "Optional view toggle: 'focus' switches to single full-bleed view, 'spotlight' switches to multi-tile Stage Manager view. Omit to preserve the current view.",
        },
      },
      required: ['spec_url'],
    },
    execute: ({ spec_url, mode }: { spec_url: string; mode?: 'focus' | 'spotlight' }) => {
      void (async () => {
        await executeDispatchTool({
          specUrl: spec_url,
          session,
          ctx,
          voiceToolJwt,
          bffUrl,
          chatId,
          internalSecret,
          mode,
        })
      })()
      return Promise.resolve('Dispatching now — your dashboard is updating.')
    },
  })

  return { claudeCodeTool, shareScreenTool, dispatchTool }
}
