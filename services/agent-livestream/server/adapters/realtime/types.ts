// Provider-agnostic interface for real-time room operations.
// Method signatures must NOT reference LiveKit-specific types.
export interface RealtimeRoomAdapter {
  issueClientToken(userId: string, roomId: string): Promise<string>
  createRoom(roomId: string, metadata?: string): Promise<void>
  dispatchAgent(roomId: string, agentId: string): Promise<void>
  publishDataMessage(roomId: string, topic: string, payload: unknown): Promise<void>
  subscribeRoomEvents(
    roomId: string,
    handlers: {
      onParticipantJoined?: (participantId: string) => void
      onParticipantLeft?: (participantId: string) => void
      onDataMessage?: (topic: string, payload: unknown) => void
    }
  ): () => void
  getParticipants(roomId: string): Promise<string[]>
  disconnectAgent(agentId: string): Promise<void>
  getAgentCount(roomId: string): Promise<number>
}

// Runtime constant (not just types) — imported by the swap test to verify the interface exists.
export const REALTIME_ADAPTER_METHODS = [
  'issueClientToken',
  'createRoom',
  'dispatchAgent',
  'publishDataMessage',
  'subscribeRoomEvents',
  'getParticipants',
  'disconnectAgent',
  'getAgentCount',
] as const
