// @livekit/agents (native binary dep) — must not go through livekit-adapter.ts (BFF chain)
import { llm, DEFAULT_API_CONNECT_OPTIONS } from './adapters/realtime/livekit-agents.js'
import type { APIConnectOptions } from './adapters/realtime/livekit-agents.js'
import type { LocalLLM } from './local-llm.js'
import { createLogger } from '@skill-networks/logger'

const logger = createLogger('agent-livestream:llm')

// ---------------------------------------------------------------------------
// Minimal OpenAI SSE types
// ---------------------------------------------------------------------------

export interface OAIChunk {
  id: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    completion_tokens: number
    prompt_tokens: number
    total_tokens: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

const BASE_URL = process.env['ANTHROPIC_BASE_URL'] ?? 'http://localhost:8317'
// API_KEY is no longer read from process.env at module load time.
// The voice agent uses the credential proxy (CREDENTIAL_PROXY_URL) or fetches
// the key from Vault at request time via getUserCredential(). A sentinel value
// of 'local-dev-key' is kept only for the local proxy which does not validate it.
const API_KEY = process.env['LLM_API_KEY'] ?? process.env['OPENAI_API_KEY'] ?? 'local-dev-key'

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

export class LocalLLMStream extends llm.LLMStream {
  private readonly modelName: string

  // Tool call accumulation
  private toolCallId: string | undefined
  private toolIndex: number | undefined
  private fncName: string | undefined
  private fncRawArgs: string | undefined

  constructor(
    parent: LocalLLM,
    params: { chatCtx: llm.ChatContext; toolCtx?: llm.ToolContext; connOptions?: { timeoutMs?: number } },
  ) {
    const connOptions: APIConnectOptions = {
      ...DEFAULT_API_CONNECT_OPTIONS,
      ...(params.connOptions?.timeoutMs !== undefined ? { timeoutMs: params.connOptions.timeoutMs } : {}),
    }
    super(parent, { ...params, connOptions })
    this.modelName = parent.modelName
  }

  protected async run(): Promise<void> {
    const messages = (await this.chatCtx.toProviderFormat('openai')) as Record<string, unknown>[]
    const tools = this.toolCtx
      ? Object.entries(this.toolCtx).map(([name, func]) => ({
          type: 'function',
          function: {
            name,
            description: func.description,
            parameters: llm.toJsonSchema(func.parameters, true, false),
          },
        }))
      : undefined

    // Sanitize tool_call IDs to satisfy Anthropic's ^[a-zA-Z0-9_-]+$ pattern.
    const idMap = new Map<string, string>()
    const sanitizeId = (raw: string): string => {
      if (!idMap.has(raw)) {
        idMap.set(raw, `call_${idMap.size}_${Date.now()}`)
      }
      return idMap.get(raw)!
    }
    for (const msg of messages) {
      const m = msg as Record<string, unknown>
      if (m['role'] === 'assistant' && Array.isArray(m['tool_calls'])) {
        for (const tc of m['tool_calls'] as Array<Record<string, unknown>>) {
          if (typeof tc['id'] === 'string') tc['id'] = sanitizeId(tc['id'])
        }
      }
      if (m['role'] === 'tool' && typeof m['tool_call_id'] === 'string') {
        m['tool_call_id'] = sanitizeId(m['tool_call_id'])
      }
    }

    const body: Record<string, unknown> = {
      model: this.modelName,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }
    if (tools) body['tools'] = tools

    // Detailed request body logging for debugging tool-call regressions.
    // Truncates message content to keep log lines bounded; tool schemas are
    // serialized in full because their shape (parameters JSON Schema) is
    // exactly what we need to inspect when the model fails to emit tool_calls.
    // API key is intentionally not logged.
    const summarizedTools = Array.isArray(tools)
      ? tools.map((t) => {
          const fn = (t as { function?: { name?: string; description?: string; parameters?: unknown } }).function ?? {}
          return {
            name: fn.name,
            descriptionPreview: typeof fn.description === 'string' ? fn.description.slice(0, 200) : undefined,
            parameters: fn.parameters,
          }
        })
      : []
    const messagesTail = messages.slice(-5).map((m) => {
      const r = (m as Record<string, unknown>)['role']
      const c = (m as Record<string, unknown>)['content']
      const contentLen =
        typeof c === 'string' ? c.length : Array.isArray(c) ? JSON.stringify(c).length : c == null ? 0 : JSON.stringify(c).length
      return { role: r, contentLen }
    })
    logger.info('llm.request.body', {
      model: this.modelName,
      messagesCount: messages.length,
      messagesTail,
      tools: summarizedTools,
    })
    const chatCtxPrefix = messages.slice(-5).map((m) => {
      const r = (m as Record<string, unknown>)['role']
      const c = (m as Record<string, unknown>)['content']
      const preview =
        typeof c === 'string' ? c.slice(0, 200) : c == null ? '' : JSON.stringify(c).slice(0, 200)
      return { role: r, contentPreview: preview }
    })
    logger.debug('llm.request.chatCtx', { lastFive: chatCtxPrefix })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.connOptions?.timeoutMs ?? 30_000)

    const requestStartedAt = Date.now()
    logger.info('llm.request.start', {
      model: this.modelName,
      baseURL: BASE_URL,
      messageCount: messages.length,
      toolCount: tools?.length ?? 0,
      apiKeyLength: API_KEY.length,
      timeoutMs: this.connOptions?.timeoutMs ?? 30_000,
    })
    logger.info('phase', { phase: 'llm_request_started', t_ms: performance.now() })

    let chunkIndex = 0
    let totalContentLength = 0
    let lastFinishReason: string | null | undefined
    const seenToolCalls: Array<{ id?: string; name?: string; argsLen: number }> = []
    let firstChunkLogged = false
    let firstToolCallChunkLogged = false

    try {
      const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      logger.info('llm.response.headers', {
        status: res.status,
        contentType: res.headers.get('content-type'),
        requestId: res.headers.get('x-request-id') ?? res.headers.get('request-id'),
        elapsedMs: Date.now() - requestStartedAt,
      })

      if (!res.ok) {
        const text = await res.text()
        logger.error('llm.response.not-ok', { status: res.status, body: text.slice(0, 500) })
        throw new Error(`HTTP ${res.status}: ${text}`)
      }

      if (!res.body) throw new Error('Response body is null')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        if (this.abortController.signal.aborted) {
          logger.warn('llm.stream.aborted', { chunkIndex })
          break
        }
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })

        const lines = buf.split('\n')
        buf = lines.pop() ?? ''

        for (const line of lines) {
          const stripped = line.trim()
          if (!stripped.startsWith('data:')) continue
          const payload = stripped.slice(5).trim()
          if (payload === '[DONE]') {
            logger.info('phase', { phase: 'llm_stream_done', t_ms: performance.now() })
            logger.info('llm.stream.done', {
              totalChunks: chunkIndex,
              totalContentLength,
              finishReason: lastFinishReason,
              toolCallsSeen: seenToolCalls.length,
              toolCalls: seenToolCalls,
              orphan: this.toolCallId
                ? {
                    toolCallId: this.toolCallId,
                    fncName: this.fncName,
                    fncRawArgsLen: this.fncRawArgs?.length ?? 0,
                  }
                : null,
              elapsedMs: Date.now() - requestStartedAt,
            })
            return
          }
          try {
            const chunk = JSON.parse(payload) as OAIChunk
            if (!firstChunkLogged) {
              firstChunkLogged = true
              logger.info('phase', { phase: 'llm_first_chunk', t_ms: performance.now() })
            }
            const choice = chunk.choices?.[0]
            const delta = choice?.delta
            const deltaKeys = delta ? Object.keys(delta) : []
            const tcCount = delta?.tool_calls?.length ?? 0
            if (tcCount > 0 && !firstToolCallChunkLogged) {
              firstToolCallChunkLogged = true
              logger.info('phase', { phase: 'llm_first_tool_call_chunk', t_ms: performance.now() })
            }
            const contentLen = typeof delta?.content === 'string' ? delta.content.length : 0
            totalContentLength += contentLen
            if (choice?.finish_reason) lastFinishReason = choice.finish_reason

            if (tcCount > 0) {
              for (const tc of delta!.tool_calls!) {
                const fnName = tc.function?.name
                const argsLen = tc.function?.arguments?.length ?? 0
                if (fnName) {
                  seenToolCalls.push({ id: tc.id, name: fnName, argsLen })
                } else if (seenToolCalls.length > 0 && argsLen > 0) {
                  seenToolCalls[seenToolCalls.length - 1]!.argsLen += argsLen
                }
              }
            }

            logger.debug('llm.chunk', {
              i: chunkIndex,
              deltaKeys,
              contentLen,
              tcCount,
              finishReason: choice?.finish_reason ?? null,
            })

            // Detect tool_calls in chunks the parser might drop (no function payload)
            if (delta?.tool_calls && tcCount > 0 && !delta.tool_calls.some((t) => t.function)) {
              logger.warn('llm.chunk.tool_calls.no-function', {
                i: chunkIndex,
                raw: delta.tool_calls,
              })
            }

            chunkIndex++
            this.processChunk(chunk)
          } catch (err) {
            logger.warn('llm.chunk.parse-failed', {
              i: chunkIndex,
              payloadPreview: payload.slice(0, 120),
              err: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }

      logger.info('phase', { phase: 'llm_stream_done', t_ms: performance.now(), reason: 'closed-no-done' })
      logger.info('llm.stream.closed-no-done', {
        totalChunks: chunkIndex,
        totalContentLength,
        finishReason: lastFinishReason,
        toolCallsSeen: seenToolCalls.length,
        toolCalls: seenToolCalls,
        orphan: this.toolCallId
          ? { toolCallId: this.toolCallId, fncName: this.fncName, fncRawArgsLen: this.fncRawArgs?.length ?? 0 }
          : null,
        elapsedMs: Date.now() - requestStartedAt,
      })
    } catch (err) {
      const e = err as Error & { cause?: unknown }
      logger.error('llm.request.failed', {
        elapsedMs: Date.now() - requestStartedAt,
        chunkIndex,
        message: e?.message,
        name: e?.name,
        stack: e?.stack,
        cause: e?.cause,
        aborted: this.abortController.signal.aborted,
      })
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  private processChunk(chunk: OAIChunk): void {
    for (const choice of chunk.choices) {
      if (this.abortController.signal.aborted) return
      const parsed = this.parseChoice(chunk.id, choice)
      if (parsed) this.queue.put(parsed)
    }
    if (chunk.usage) {
      const u = chunk.usage
      this.queue.put({
        id: chunk.id,
        usage: {
          completionTokens: u.completion_tokens,
          promptTokens: u.prompt_tokens,
          promptCachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
          totalTokens: u.total_tokens,
        },
      })
    }
  }

  private parseChoice(id: string, choice: OAIChunk['choices'][0]): llm.ChatChunk | undefined {
    const delta = choice.delta
    if (!delta) return undefined

    if (delta.tool_calls) {
      for (const tool of delta.tool_calls) {
        if (!tool.function) continue

        let callChunk: llm.ChatChunk | undefined
        if (this.toolCallId && tool.id && tool.index !== this.toolIndex) {
          callChunk = this.makeToolChunk(id)
          this.toolCallId = this.fncName = this.fncRawArgs = undefined
        }

        if (tool.function.name) {
          this.toolIndex = tool.index
          this.toolCallId = tool.id
          this.fncName = tool.function.name
          this.fncRawArgs = tool.function.arguments ?? ''
        } else if (tool.function.arguments) {
          this.fncRawArgs = (this.fncRawArgs ?? '') + tool.function.arguments
        }
        if (callChunk) return callChunk
      }
    }

    if (
      choice.finish_reason &&
      ['tool_calls', 'stop'].includes(choice.finish_reason) &&
      this.toolCallId !== undefined
    ) {
      const callChunk = this.makeToolChunk(id)
      this.toolCallId = this.fncName = this.fncRawArgs = undefined
      return callChunk
    }

    if (!delta.content) return undefined
    return { id, delta: { role: 'assistant', content: delta.content } }
  }

  private makeToolChunk(id: string): llm.ChatChunk {
    const callId = this.toolCallId || `call_${Date.now()}_${id.replace(/[^a-zA-Z0-9_-]/g, '')}`
    return {
      id,
      delta: {
        role: 'assistant',
        toolCalls: [
          llm.FunctionCall.create({
            callId,
            name: this.fncName ?? '',
            args: this.fncRawArgs ?? '',
          }),
        ],
      },
    }
  }
}
