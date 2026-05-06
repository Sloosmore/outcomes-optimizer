export type SessionState = 'idle' | 'connecting' | 'thinking' | 'listening' | 'speaking' | 'calling' | 'error'

export interface TranscriptDelta {
  role: 'user' | 'assistant'
  content: string
  final: boolean
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ArtifactSideEffect {
  port: number
  label: string
  url?: string
  path?: string
}

export interface VoiceSessionAdapter {
  connect(tools: ToolDef[], systemPrompt: string): Promise<void>
  disconnect(): void
  sendText(text: string): void
  on(event: 'transcript', handler: (delta: TranscriptDelta) => void): void
  on(event: 'state', handler: (state: SessionState) => void): void
  on(event: 'volume', handler: (volume: number) => void): void
  on(event: 'artifact', handler: (artifact: ArtifactSideEffect) => void): void
  off(event: string, handler: (...args: unknown[]) => void): void
}
