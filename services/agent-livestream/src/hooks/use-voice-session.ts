import { useEffect, useRef, useState, useCallback } from 'react'
import { createAdapter } from '@/adapters/adapter-factory.ts'
import type { VoiceSessionAdapter, SessionState, TranscriptDelta, ArtifactSideEffect } from '@/adapters/voice-session-adapter.ts'
import { apiFetch } from '@/lib/api-fetch'
import type { ApiChatConfigResponse } from '@skill-networks/contracts/chat'

declare global {
  interface Window {
    __transcripts?: TranscriptDelta[]
    __injectAudio?: (pcm16Base64: string) => void
    __sendText?: (text: string) => void
    __injectArtifact?: (a: ArtifactSideEffect) => void
  }
}

export function useVoiceSession() {
  const adapterRef = useRef<VoiceSessionAdapter | null>(null)
  const [sessionState, setSessionState] = useState<SessionState>('idle')
  const [volume, setVolume] = useState(0)
  const [transcripts, setTranscripts] = useState<TranscriptDelta[]>([])
  const [artifact, setArtifact] = useState<ArtifactSideEffect | null>(null)

  const getAdapter = useCallback(() => {
    if (!adapterRef.current) {
      const params = new URLSearchParams(window.location.search)
      adapterRef.current = createAdapter(params, apiFetch)
    }
    return adapterRef.current
  }, [])

  const handleTranscript = useCallback((delta: TranscriptDelta) => {
    setTranscripts((prev) => {
      const next = [...prev, delta]
      if (import.meta.env.VITE_TEST === '1') {
        window.__transcripts = next
      }
      return next
    })
  }, [])

  const handleState = useCallback((state: SessionState) => {
    setSessionState(state)
  }, [])

  const handleVolume = useCallback((v: number) => {
    setVolume(v)
  }, [])

  const handleArtifact = useCallback((a: ArtifactSideEffect) => {
    setArtifact(a)
  }, [])

  // Test hook: exposes handleArtifact so Playwright tests can simulate artifact events
  // without a live voice session. Syncs with the window object (external system).
  useEffect(() => {
    if (import.meta.env.VITE_TEST === '1') {
      window.__injectArtifact = handleArtifact
    }
  }, [handleArtifact])

  const connect = useCallback(async () => {
    const adapter = getAdapter()
    adapter.on('transcript', handleTranscript)
    adapter.on('state', handleState)
    adapter.on('volume', handleVolume)
    adapter.on('artifact', handleArtifact)
    const cfg = await apiFetch('/api/chat/config').then(r => {
      if (!r.ok) throw new Error(`config fetch failed: ${r.status}`)
      return r.json() as Promise<ApiChatConfigResponse>
    })
    await adapter.connect(cfg.tools, cfg.systemPrompt)
  }, [getAdapter, handleTranscript, handleState, handleVolume, handleArtifact])

  const disconnect = useCallback(() => {
    const adapter = adapterRef.current
    if (!adapter) return
    adapter.off('transcript', handleTranscript as (...args: unknown[]) => void)
    adapter.off('state', handleState as (...args: unknown[]) => void)
    adapter.off('volume', handleVolume as (...args: unknown[]) => void)
    adapter.off('artifact', handleArtifact as (...args: unknown[]) => void)
    adapter.disconnect()
  }, [handleTranscript, handleState, handleVolume, handleArtifact])

  const sendText = useCallback((text: string) => {
    getAdapter().sendText(text)
  }, [getAdapter])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.has('autostart')) {
      const message = params.get('message')
      void connect().then(() => {
        if (message) {
          sendText(message)
        }
      })
    }
    return () => {
      disconnect()
    }
    // Autostart only fires on mount — intentional one-time check
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { state: sessionState, volume, transcripts, artifact, sendText, connect, disconnect }
}
