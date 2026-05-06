import { useState, useCallback } from 'react'
import { SSEEventSchema } from '@skill-networks/contracts/sse'
import { apiFetch } from '@/lib/api-fetch'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  tool_calls?: unknown
}

interface ArtifactState {
  port: number
  label: string
  path?: string
  url: string
}

export function useMessages(chatId: string) {
  const [messages, setMessages] = useState<Message[]>([])
  const [resolvedChatId, setResolvedChatId] = useState(chatId)
  const [artifact, setArtifact] = useState<ArtifactState | null>(null)

  const sendMessage = useCallback(async (content: string) => {
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
    }
    setMessages((prev) => [...prev, userMessage])

    const assistantId = crypto.randomUUID()
    setMessages((prev) => [...prev, { id: assistantId, role: 'assistant', content: '' }])

    try {
      const response = await apiFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: resolvedChatId,
          messages: [{ role: 'user', content }],
        }),
      })

      if (!response.ok || !response.body) {
        setMessages((prev) => prev.filter((m) => m.id !== assistantId))
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''
      let buffer = ''
      let artifactFound = false

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue
          const payload = trimmed.slice(6)

          if (payload === '[DONE]') {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: accumulated } : m)),
            )
            continue
          }

          try {
            const json: unknown = JSON.parse(payload)
            const result = SSEEventSchema.safeParse(json)
            if (!result.success) {
              console.warn('Unknown SSE event', payload)
              continue
            }
            const event = result.data

            if (event.type === 'RUN_STARTED') {
              setResolvedChatId(event.threadId)
              continue
            }

            if (event.type === 'ARTIFACT') {
              if (!artifactFound) {
                setArtifact({ port: event.port, label: event.label, url: event.url, ...(event.path ? { path: event.path } : {}) })
                artifactFound = true
              }
              continue
            }

            if (event.type === 'TEXT_MESSAGE_CONTENT') {
              accumulated += event.delta
              const snap = accumulated
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, content: snap } : m)),
              )
            }

            if (event.type === 'RUN_ERROR') {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: `[Error: ${event.message}]` } : m,
                ),
              )
            }
          } catch {
            console.warn('Malformed SSE payload', payload)
          }
        }
      }
    } catch {
      // Network-level failure (DNS, connection refused, etc.) — remove the ghost placeholder
      setMessages((prev) => prev.filter((m) => m.id !== assistantId))
    }
  }, [resolvedChatId])

  return { messages, sendMessage, chatId: resolvedChatId, artifact }
}
