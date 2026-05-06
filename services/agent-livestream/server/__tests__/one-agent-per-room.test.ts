/**
 * Story 6 — One agent per room enforcement.
 *
 * Tests the dispatchAgentIfAllowed helper exported from token.ts.
 * Uses a fake adapter so no LiveKit credentials are required.
 */
import { describe, it, expect } from 'vitest'
import type { RealtimeRoomAdapter } from '../adapters/realtime/types.js'
import { dispatchAgentIfAllowed } from '../routes/token.js'
import { MAX_AGENTS_PER_ROOM } from '../constants.js'

// ---------------------------------------------------------------------------
// Minimal fake adapter — only the methods needed for these tests
// ---------------------------------------------------------------------------

class FakeRealtimeRoomAdapter implements RealtimeRoomAdapter {
  private rooms = new Map<string, Set<string>>()
  private agentIndex = new Map<string, string>() // agentId → roomId

  async issueClientToken(userId: string, roomId: string): Promise<string> {
    return `fake-token:${userId}:${roomId}`
  }

  async createRoom(roomId: string): Promise<void> {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Set())
    }
  }

  async dispatchAgent(roomId: string, agentId: string): Promise<void> {
    const room = this.rooms.get(roomId) ?? new Set()
    room.add(agentId)
    this.rooms.set(roomId, room)
    this.agentIndex.set(agentId, roomId)
  }

  async publishDataMessage(_roomId: string, _topic: string, _payload: unknown): Promise<void> {
    // no-op in fake
  }

  subscribeRoomEvents(
    _roomId: string,
    _handlers: {
      onParticipantJoined?: (participantId: string) => void
      onParticipantLeft?: (participantId: string) => void
      onDataMessage?: (topic: string, payload: unknown) => void
    },
  ): () => void {
    return () => { /* unsubscribe no-op */ }
  }

  async getParticipants(roomId: string): Promise<string[]> {
    return Array.from(this.rooms.get(roomId) ?? [])
  }

  async disconnectAgent(agentId: string): Promise<void> {
    const roomId = this.agentIndex.get(agentId)
    if (roomId) {
      this.rooms.get(roomId)?.delete(agentId)
      this.agentIndex.delete(agentId)
    }
  }

  async getAgentCount(roomId: string): Promise<number> {
    // Agents were added via dispatchAgent — all participants in this fake are agents
    return this.rooms.get(roomId)?.size ?? 0
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('one agent per room enforcement', () => {
  it('MAX_AGENTS_PER_ROOM is 1', () => {
    expect(MAX_AGENTS_PER_ROOM).toBe(1)
  })

  it('first dispatch to a room succeeds', async () => {
    const adapter = new FakeRealtimeRoomAdapter()
    await adapter.createRoom('room-a')

    const result = await dispatchAgentIfAllowed(adapter, 'room-a', 'voice-agent')
    expect(result).toEqual({ dispatched: true })
  })

  it('second dispatch to the same room is rejected with AGENT_LIMIT_EXCEEDED', async () => {
    const adapter = new FakeRealtimeRoomAdapter()
    await adapter.createRoom('room-b')

    const first = await dispatchAgentIfAllowed(adapter, 'room-b', 'voice-agent')
    expect(first.dispatched).toBe(true)

    const second = await dispatchAgentIfAllowed(adapter, 'room-b', 'voice-agent')
    expect(second).toEqual({ dispatched: false, reason: 'AGENT_LIMIT_EXCEEDED' })
  })

  it('dispatch to a different room is independent and succeeds', async () => {
    const adapter = new FakeRealtimeRoomAdapter()
    await adapter.createRoom('room-c')
    await adapter.createRoom('room-d')

    await dispatchAgentIfAllowed(adapter, 'room-c', 'voice-agent')

    const result = await dispatchAgentIfAllowed(adapter, 'room-d', 'voice-agent')
    expect(result).toEqual({ dispatched: true })
  })

  it('agent count stays at 1 after a successful dispatch', async () => {
    const adapter = new FakeRealtimeRoomAdapter()
    await adapter.createRoom('room-e')

    await dispatchAgentIfAllowed(adapter, 'room-e', 'voice-agent')
    const count = await adapter.getAgentCount('room-e')
    expect(count).toBe(1)
  })
})
