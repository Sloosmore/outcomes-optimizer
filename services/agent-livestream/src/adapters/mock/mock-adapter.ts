import type { TranscriptDelta, ToolDef, VoiceSessionAdapter } from '../voice-session-adapter.ts'

type EventName = 'transcript' | 'state' | 'volume' | 'artifact'
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- handlers have varying signatures per event
type Handler = (...args: any[]) => void
interface StreamEvent { t: string; c?: string }

export class MockAdapter implements VoiceSessionAdapter {
  private listeners = new Map<string, Set<Handler>>()
  private chatId: string
  private controller: AbortController | null = null

  private readonly fetch: (url: string, init?: RequestInit) => Promise<Response>
  constructor(fetch: (url: string, init?: RequestInit) => Promise<Response>) {
    this.fetch = fetch
    this.chatId = this.extractChatId()
  }

  private extractChatId(): string {
    const match = window.location.pathname.match(/\/chat\/([^/]+)/)
    const id = match?.[1]
    if (id && id !== 'new') return id
    return 'new'
  }

  async connect(_tools: ToolDef[], _systemPrompt: string): Promise<void> {
    this.emit('state', 'connecting')
    this.emit('state', 'listening')
  }

  disconnect(): void {
    this.controller?.abort()
    this.controller = null
  }

  sendText(text: string): void {
    this.controller?.abort()
    this.controller = new AbortController()
    void this.handleSend(text, this.controller.signal)
  }

  on(event: EventName, handler: Handler): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    const set = this.listeners.get(event)
    if (set) set.add(handler)
  }

  off(event: string, handler: Handler): void {
    this.listeners.get(event)?.delete(handler)
  }

  private emit(event: string, ...args: unknown[]): void {
    const handlers = this.listeners.get(event)
    if (!handlers) return
    for (const handler of handlers) {
      handler(...args)
    }
  }

  private async handleSend(text: string, signal: AbortSignal): Promise<void> {
    this.emit('state', 'thinking')
    // Emit placeholder first (voice-style: shows "User speaking..." until response arrives)
    this.emit('transcript', { role: 'user', content: 'User speaking…', final: false } satisfies TranscriptDelta)
    // Small delay so Playwright can observe the placeholder state
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    if (signal.aborted) return

    const response = await this.fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: this.chatId, messages: [{ role: 'user', content: text }] }),
      signal,
    })

    if (!response.ok || !response.body) {
      this.emit('state', 'error')
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let accumulated = ''
    let firstChunk = true
    let buffer = ''

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (signal.aborted) return
          this.processLine(line, firstChunk, accumulated, (newAccumulated, nowFirstChunk) => {
            accumulated = newAccumulated
            firstChunk = nowFirstChunk
          })
        }
      }
    } catch {
      if (!signal.aborted) this.emit('state', 'error')
      return
    }

    // Resolve user placeholder with actual text, then finalize assistant
    this.emit('transcript', { role: 'user', content: text, final: true } satisfies TranscriptDelta)
    this.emit('transcript', { role: 'assistant', content: accumulated, final: true } satisfies TranscriptDelta)
    this.emit('state', 'idle')
    this.emit('volume', 0)
  }

  private processLine(
    line: string,
    firstChunk: boolean,
    accumulated: string,
    update: (acc: string, first: boolean) => void,
  ): void {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data: ')) return
    const payload = trimmed.slice(6)

    if (payload === '[DONE]') return

    try {
      const parsed = JSON.parse(payload) as StreamEvent

      if (parsed.t === 'chatId' && parsed.c) {
        this.chatId = parsed.c
        return
      }

      if (parsed.t === 'chunk' && parsed.c != null) {
        if (firstChunk) {
          this.emit('state', 'speaking')
          update(accumulated, false)
        }
        this.emit('volume', 0.6)
        const newAccumulated = accumulated + parsed.c
        update(newAccumulated, false)
        this.emit('transcript', { role: 'assistant', content: newAccumulated, final: false } satisfies TranscriptDelta)
      }
    } catch {
      // ignore malformed SSE data
    }
  }
}
