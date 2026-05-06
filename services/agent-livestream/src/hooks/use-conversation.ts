/**
 * use-conversation.ts — The ONLY file in src/ that may import from livekit-client
 * or @livekit/components-react. All other src/ files import from this file instead.
 *
 * This file serves dual purpose:
 * 1. Re-exports all LiveKit types and functions other src/ files need
 * 2. Implements the useConversation() hook
 */

// ---------------------------------------------------------------------------
// Side-effect import for LiveKit component styles
// ---------------------------------------------------------------------------
import '@livekit/components-styles'

// ---------------------------------------------------------------------------
// Re-exports from livekit-client
// ---------------------------------------------------------------------------
export type { LocalAudioTrack, RemoteAudioTrack } from 'livekit-client'
export { Track, TokenSource, MediaDeviceFailure } from 'livekit-client'
export type { LocalVideoTrack } from 'livekit-client'

// ---------------------------------------------------------------------------
// Re-exports from @livekit/components-react
// ---------------------------------------------------------------------------
export type {
  AgentState,
  TrackReferenceOrPlaceholder,
  TrackReference,
} from '@livekit/components-react'
export {
  useMultibandTrackVolume,
  useChat,
  useSessionContext,
  VideoTrack,
  useVoiceAssistant,
  RoomAudioRenderer,
  useMaybeRoomContext,
  useMediaDeviceSelect,
  useTrackToggle,
  usePersistentUserChoices,
  useLocalParticipantPermissions,
  useTextStream,
  useConnectionState,
  LiveKitRoom,
  SessionProvider,
  useRoomContext,
  useSession,
} from '@livekit/components-react'

// ---------------------------------------------------------------------------
// useConversation() hook
// ---------------------------------------------------------------------------
import { useState } from 'react'
import { useRoomContext, useTracks } from '@livekit/components-react'

export interface ConversationMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  timestamp: number
}

export interface UseConversationOptions {
  chatId: string
}

export interface UseConversationReturn {
  messages: ConversationMessage[]
  sendUserText: (text: string) => Promise<void>
  connectionState: string
  audioTracks: unknown[]
  _testInjectAssistantMessage: (text: string) => void
}

export function useConversation({ chatId: _chatId }: UseConversationOptions): UseConversationReturn {
  const [messages, setMessages] = useState<ConversationMessage[]>([])

  const room = useRoomContext()
  const connectionState: string = (room as { state?: string }).state ?? 'disconnected'

  const audioTracks = useTracks()

  async function sendUserText(text: string): Promise<void> {
    const msg: ConversationMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    }
    setMessages((prev) => [...prev, msg])
  }

  function _testInjectAssistantMessage(text: string): void {
    const msg: ConversationMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: text,
      timestamp: Date.now(),
    }
    setMessages((prev) => [...prev, msg])
  }

  return {
    messages,
    sendUserText,
    connectionState,
    audioTracks,
    _testInjectAssistantMessage,
  }
}
