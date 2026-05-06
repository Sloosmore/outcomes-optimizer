/**
 * LocalLLM — calls the local CLI proxy at http://localhost:8317 using the
 * OpenAI chat completions API format + native fetch (no extra npm dep).
 * Bypasses LiveKit's inference gateway entirely.
 */
// @livekit/agents (native binary dep) — must not go through livekit-adapter.ts (BFF chain)
import { llm } from './adapters/realtime/livekit-agents.js'
import { LocalLLMStream } from './local-llm-stream.js'

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export class LocalLLM extends llm.LLM {
  readonly modelName: string

  constructor(model = 'claude-haiku-4-5-20251001') {
    super()
    this.modelName = model
  }

  label() {
    return 'LocalLLM'
  }

  get model() {
    return this.modelName
  }

  chat(params: {
    chatCtx: llm.ChatContext
    toolCtx?: llm.ToolContext
    connOptions?: { timeoutMs?: number }
    parallelToolCalls?: boolean
    toolChoice?: llm.ToolChoice
    extraKwargs?: Record<string, unknown>
  }): llm.LLMStream {
    return new LocalLLMStream(this, params)
  }
}
