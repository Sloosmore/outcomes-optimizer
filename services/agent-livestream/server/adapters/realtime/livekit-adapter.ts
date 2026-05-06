import { AccessToken, RoomServiceClient, AgentDispatchClient, DataPacket_Kind } from 'livekit-server-sdk'
import type { RealtimeRoomAdapter } from './types.js'

export class LiveKitRealtimeRoomAdapter implements RealtimeRoomAdapter {
  private roomSvc: RoomServiceClient
  private dispatchSvc: AgentDispatchClient
  private readonly apiKey: string
  private readonly apiSecret: string

  constructor(livekitUrl: string, apiKey: string, apiSecret: string) {
    this.apiKey = apiKey
    this.apiSecret = apiSecret
    this.roomSvc = new RoomServiceClient(livekitUrl, apiKey, apiSecret)
    this.dispatchSvc = new AgentDispatchClient(livekitUrl, apiKey, apiSecret)
  }

  async issueClientToken(userId: string, roomId: string): Promise<string> {
    const at = new AccessToken(this.apiKey, this.apiSecret, { identity: userId, ttl: '1h' })
    at.addGrant({ roomCreate: true, roomJoin: true, room: roomId, canPublish: true, canSubscribe: true })
    return at.toJwt()
  }

  async createRoom(roomId: string, metadata?: string): Promise<void> {
    await this.roomSvc.createRoom({ name: roomId, ...(metadata !== undefined ? { metadata } : {}) })
  }

  async dispatchAgent(roomId: string, agentId: string): Promise<void> {
    await this.dispatchSvc.createDispatch(roomId, agentId)
  }

  async publishDataMessage(roomId: string, topic: string, payload: unknown): Promise<void> {
    const data = new TextEncoder().encode(JSON.stringify(payload))
    await this.roomSvc.sendData(roomId, data, DataPacket_Kind.RELIABLE, { topic })
  }

  subscribeRoomEvents(
    _roomId: string,
    _handlers: {
      onParticipantJoined?: (participantId: string) => void
      onParticipantLeft?: (participantId: string) => void
      onDataMessage?: (topic: string, payload: unknown) => void
    }
  ): () => void {
    // Webhook-based subscription (full impl in Story 6).
    // Returns a no-op unsubscribe for now.
    return () => {}
  }

  async getParticipants(roomId: string): Promise<string[]> {
    const participants = await this.roomSvc.listParticipants(roomId)
    return participants.map(p => p.identity)
  }

  async getAgentCount(roomId: string): Promise<number> {
    const participants = await this.roomSvc.listParticipants(roomId)
    // ParticipantInfo_Kind.AGENT = 4 in livekit-server-sdk
    return participants.filter(p => p.kind === 4).length
  }

  async disconnectAgent(agentId: string): Promise<void> {
    // Note: we need roomId to disconnect — for now accept agentId only and search.
    // In Story 6 the BFF will track room→agent mapping.
    // As a best-effort, attempt to remove from any known rooms.
    // This no-op is acceptable until Story 6 wires the full tracking.
    void agentId
  }
}

// Re-export livekit-server-sdk classes so other server files import from this
// single file rather than directly from livekit-server-sdk.
// Only livekit-server-sdk is safe to import in the Vercel BFF chain —
// @livekit/agents and its plugins require @livekit/rtc-node (a native binary).
// Those are in livekit-agents.ts, which is excluded from the BFF import chain.
export { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk'

