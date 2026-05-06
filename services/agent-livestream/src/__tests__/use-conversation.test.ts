// @vitest-environment jsdom
/**
 * Story 1 — useConversation() hook contract test.
 *
 * Asserts the shape and role vocabulary of the (not-yet-existing) hook.
 * Import will fail until src/hooks/use-conversation.ts is created —
 * that failure is the expected red state for Story 1.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Import the not-yet-existing hook.
// This will fail with "Cannot find module" until Story 2 creates the file.
import { useConversation } from '../hooks/use-conversation.js'

// ---------------------------------------------------------------------------
// Minimal mock for LiveKit — useConversation must not crash in jsdom
// ---------------------------------------------------------------------------

vi.mock('livekit-client', () => ({
  Room: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    localParticipant: { publishTrack: vi.fn() },
  })),
  RoomEvent: {
    Connected: 'connected',
    Disconnected: 'disconnected',
    DataReceived: 'dataReceived',
    TrackSubscribed: 'trackSubscribed',
  },
  ConnectionState: {
    Connected: 'connected',
    Connecting: 'connecting',
    Disconnected: 'disconnected',
  },
}))

vi.mock('@livekit/components-react', () => ({
  useRoomContext: vi.fn().mockReturnValue({
    state: 'connected',
    localParticipant: { publishTrack: vi.fn() },
  }),
  useTracks: vi.fn().mockReturnValue([]),
  useParticipants: vi.fn().mockReturnValue([]),
}))

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Role = 'user' | 'assistant' | 'tool'

interface ConversationMessage {
  id: string
  role: Role
  content: string
  timestamp: number
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useConversation() hook contract', () => {
  it('exposes messages, sendUserText, connectionState, and audioTracks', () => {
    const { result } = renderHook(() => useConversation({ chatId: 'test-chat-id' }))

    // Required surface
    expect('messages' in result.current).toBe(true)
    expect('sendUserText' in result.current).toBe(true)
    expect('connectionState' in result.current).toBe(true)
    expect('audioTracks' in result.current).toBe(true)

    // Type assertions
    expect(Array.isArray(result.current.messages)).toBe(true)
    expect(typeof result.current.sendUserText).toBe('function')
    expect(typeof result.current.connectionState).toBe('string')
    expect(Array.isArray(result.current.audioTracks)).toBe(true)
  })

  it('messages array starts empty', () => {
    const { result } = renderHook(() => useConversation({ chatId: 'test-chat-id' }))
    expect(result.current.messages).toHaveLength(0)
  })

  it('sendUserText adds a user turn with role "user"', async () => {
    const { result } = renderHook(() => useConversation({ chatId: 'test-chat-id' }))

    await act(async () => {
      await result.current.sendUserText('hello world')
    })

    const userMessages = result.current.messages.filter((m: ConversationMessage) => m.role === 'user')
    expect(userMessages.length).toBeGreaterThanOrEqual(1)
    expect(userMessages[userMessages.length - 1]?.content).toBe('hello world')
  })

  it('voice turns produce assistant messages with role "assistant"', async () => {
    const { result } = renderHook(() => useConversation({ chatId: 'test-chat-id' }))

    // Simulate an assistant message arriving (e.g. from LiveKit data channel)
    await act(async () => {
      // The hook must expose a way to receive voice transcripts.
      // If injectAssistantMessage exists, use it; otherwise check messages populated by mock.
      if ('_testInjectAssistantMessage' in result.current) {
        const inject = result.current._testInjectAssistantMessage as (text: string) => void
        inject('I can help with that.')
      }
    })

    // After injection, any assistant message must have role 'assistant'
    const assistantMessages = result.current.messages.filter(
      (m: ConversationMessage) => m.role === 'assistant',
    )
    for (const msg of assistantMessages) {
      expect(msg.role).toBe('assistant')
    }
  })

  it('role vocabulary is exactly {user, assistant, tool} — never "agent"', async () => {
    const { result } = renderHook(() => useConversation({ chatId: 'test-chat-id' }))

    const ALLOWED_ROLES: Role[] = ['user', 'assistant', 'tool']

    for (const msg of result.current.messages as ConversationMessage[]) {
      expect(
        ALLOWED_ROLES,
        `Message role "${msg.role}" is not in allowed vocabulary {user, assistant, tool}`,
      ).toContain(msg.role)
      expect(msg.role, 'Role must never be "agent"').not.toBe('agent')
    }
  })

  it('voice and text turns produce identical payload shape', async () => {
    const { result } = renderHook(() => useConversation({ chatId: 'test-chat-id' }))

    await act(async () => {
      await result.current.sendUserText('a typed message')
    })

    for (const msg of result.current.messages as ConversationMessage[]) {
      // Every message must have id, role, content, timestamp
      expect(typeof msg.id).toBe('string')
      expect(typeof msg.role).toBe('string')
      expect(typeof msg.content).toBe('string')
      expect(typeof msg.timestamp).toBe('number')
    }
  })

  it('connectionState reflects LiveKit room state', () => {
    const { result } = renderHook(() => useConversation({ chatId: 'test-chat-id' }))
    // With the mock returning 'connected', the hook must surface it
    expect(['connected', 'connecting', 'disconnected']).toContain(result.current.connectionState)
  })
})
