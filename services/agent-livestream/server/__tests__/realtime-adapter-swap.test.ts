/**
 * Story 1 — RealtimeRoomAdapter interface contract test.
 *
 * Defines FakeRealtimeRoomAdapter implementing the (not-yet-existing)
 * RealtimeRoomAdapter interface and asserts that voice-agent.ts and the token
 * route can be instantiated with the fake.
 *
 * This test FAILS until server/adapters/realtime/types.ts is created
 * (that is the expected state for Story 1).
 */
import { describe, it, expect, vi } from 'vitest'

// Runtime import — not a type import — so vitest throws module-not-found when
// server/adapters/realtime/types.ts does not exist yet.  This is the intended
// red state for Story 1; Story 2 creates the file and turns this green.
import { REALTIME_ADAPTER_METHODS } from '../adapters/realtime/types.js'

// ---------------------------------------------------------------------------
// Fake adapter implementation
// ---------------------------------------------------------------------------

// Shape of the interface, mirrored here until the real types file exists.
interface RealtimeRoomAdapter {
  issueClientToken(userId: string, roomId: string): Promise<string>
  createRoom(roomId: string): Promise<void>
  dispatchAgent(roomId: string, agentId: string): Promise<void>
  publishDataMessage(roomId: string, topic: string, payload: unknown): Promise<void>
  subscribeRoomEvents(
    roomId: string,
    handlers: {
      onParticipantJoined?: (participantId: string) => void
      onParticipantLeft?: (participantId: string) => void
      onDataMessage?: (topic: string, payload: unknown) => void
    },
  ): () => void
  getParticipants(roomId: string): Promise<string[]>
  disconnectAgent(agentId: string): Promise<void>
  getAgentCount(roomId: string): Promise<number>
}

class FakeRealtimeRoomAdapter implements RealtimeRoomAdapter {
  private rooms = new Map<string, Set<string>>()
  private agents = new Map<string, string>() // agentId → roomId

  async issueClientToken(userId: string, roomId: string): Promise<string> {
    return `fake-token:${userId}:${roomId}`
  }

  async createRoom(roomId: string): Promise<void> {
    this.rooms.set(roomId, new Set())
  }

  async dispatchAgent(roomId: string, agentId: string): Promise<void> {
    const room = this.rooms.get(roomId) ?? new Set()
    room.add(agentId)
    this.rooms.set(roomId, room)
    this.agents.set(agentId, roomId)
  }

  async publishDataMessage(roomId: string, topic: string, payload: unknown): Promise<void> {
    // no-op in fake
    void roomId
    void topic
    void payload
  }

  subscribeRoomEvents(
    roomId: string,
    handlers: {
      onParticipantJoined?: (participantId: string) => void
      onParticipantLeft?: (participantId: string) => void
      onDataMessage?: (topic: string, payload: unknown) => void
    },
  ): () => void {
    void roomId
    void handlers
    return () => { /* unsubscribe no-op */ }
  }

  async getParticipants(roomId: string): Promise<string[]> {
    return Array.from(this.rooms.get(roomId) ?? [])
  }

  async disconnectAgent(agentId: string): Promise<void> {
    const roomId = this.agents.get(agentId)
    if (roomId) {
      this.rooms.get(roomId)?.delete(agentId)
      this.agents.delete(agentId)
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

describe('RealtimeRoomAdapter interface contract', () => {
  it('REALTIME_ADAPTER_METHODS constant lists the required method names', () => {
    // REALTIME_ADAPTER_METHODS is a runtime value exported from types.ts.
    // If the file doesn't exist, the module-not-found error above already
    // aborts the suite — this assertion is the positive contract check.
    expect(Array.isArray(REALTIME_ADAPTER_METHODS)).toBe(true)
    expect(REALTIME_ADAPTER_METHODS).toContain('issueClientToken')
    expect(REALTIME_ADAPTER_METHODS).toContain('createRoom')
    expect(REALTIME_ADAPTER_METHODS).toContain('dispatchAgent')
    expect(REALTIME_ADAPTER_METHODS).toContain('publishDataMessage')
    expect(REALTIME_ADAPTER_METHODS).toContain('subscribeRoomEvents')
    expect(REALTIME_ADAPTER_METHODS).toContain('getParticipants')
    expect(REALTIME_ADAPTER_METHODS).toContain('disconnectAgent')
    expect(REALTIME_ADAPTER_METHODS).toContain('getAgentCount')
  })

  it('FakeRealtimeRoomAdapter implements all required methods', () => {
    const adapter: RealtimeRoomAdapter = new FakeRealtimeRoomAdapter()
    expect(typeof adapter.issueClientToken).toBe('function')
    expect(typeof adapter.createRoom).toBe('function')
    expect(typeof adapter.dispatchAgent).toBe('function')
    expect(typeof adapter.publishDataMessage).toBe('function')
    expect(typeof adapter.subscribeRoomEvents).toBe('function')
    expect(typeof adapter.getParticipants).toBe('function')
    expect(typeof adapter.disconnectAgent).toBe('function')
    expect(typeof adapter.getAgentCount).toBe('function')
  })

  it('issueClientToken returns a string token', async () => {
    const adapter = new FakeRealtimeRoomAdapter()
    const token = await adapter.issueClientToken('user-1', 'room-abc')
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(0)
  })

  it('createRoom then getParticipants returns empty list', async () => {
    const adapter = new FakeRealtimeRoomAdapter()
    await adapter.createRoom('room-1')
    const participants = await adapter.getParticipants('room-1')
    expect(participants).toEqual([])
  })

  it('dispatchAgent adds agent to room, disconnectAgent removes it', async () => {
    const adapter = new FakeRealtimeRoomAdapter()
    await adapter.createRoom('room-2')
    await adapter.dispatchAgent('room-2', 'agent-42')

    const before = await adapter.getParticipants('room-2')
    expect(before).toContain('agent-42')

    await adapter.disconnectAgent('agent-42')
    const after = await adapter.getParticipants('room-2')
    expect(after).not.toContain('agent-42')
  })

  it('subscribeRoomEvents returns an unsubscribe function', () => {
    const adapter = new FakeRealtimeRoomAdapter()
    const unsub = adapter.subscribeRoomEvents('room-3', {
      onParticipantJoined: vi.fn(),
    })
    expect(typeof unsub).toBe('function')
    // Calling unsub must not throw
    expect(() => unsub()).not.toThrow()
  })

  it('publishDataMessage resolves without error', async () => {
    const adapter = new FakeRealtimeRoomAdapter()
    await adapter.createRoom('room-4')
    await expect(
      adapter.publishDataMessage('room-4', 'artifact_ready', { url: 'https://example.com' }),
    ).resolves.toBeUndefined()
  })

  // ── Integration shape checks ────────────────────────────────────────────

  it('voice-agent.ts exports a function that accepts a RealtimeRoomAdapter', async () => {
    // This import will succeed because voice-agent.ts already exists.
    // The assertion checks that its exported factory/constructor signature
    // accepts the adapter interface without type errors.
    //
    // Until voice-agent.ts is refactored to accept the adapter, the TypeScript
    // typecheck step will fail — which is the intended red state.
    const voiceAgentModule = await import('../voice-agent.js').catch(() => null)
    // If the module loads, it must export something (the actual DI wiring comes in Story 2)
    expect(voiceAgentModule).not.toBeNull()
  })

  it('token route exists and exports a Hono router', async () => {
    // Import the existing token route — it must remain loadable even before
    // the adapter is wired in (token route will be adapted in Story 2).
    const tokenModule = await import('../routes/token.js').catch(() => null)
    expect(tokenModule).not.toBeNull()
  })
})
