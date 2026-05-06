import { MockAdapter } from './mock/mock-adapter.ts'
import type { VoiceSessionAdapter } from './voice-session-adapter.ts'

export function createAdapter(
  params: URLSearchParams,
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
): VoiceSessionAdapter {
  const adapter = params.get('adapter') ?? 'mock'
  switch (adapter) {
    case 'mock':
      return new MockAdapter(fetch)
    default:
      throw new Error(`Unknown adapter "${adapter}" — only "mock" is currently available`)
  }
}
