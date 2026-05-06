import { useEffect, useRef, useState } from 'react'
import {
  RoomAudioRenderer,
  useVoiceAssistant,
  useChat,
  useTextStream,
} from '../hooks/use-conversation.js'
import { useQueryClient } from '@tanstack/react-query'
import { MessageAdded } from '@skill-networks/contracts/livekit'
import type { MessageRow as MessageRowType } from '@skill-networks/contracts/chat'
import { MessageSquareText, SendHorizontal } from 'lucide-react'
import { Orb, type AgentState as OrbState } from '@/components/ui/elevenlabs-orb'
import { AgentChatTranscript } from '@/components/agents-ui/agent-chat-transcript'
import { AgentControlBar } from '@/components/agents-ui/agent-control-bar'
import { StageTile } from '@/components/stage-tile'
import { StageRenderer } from '@/components/stage-manager/renderers/stage-renderer'
import { StageModeToggle } from '@/components/stage-manager/stage-mode-toggle'
import { useWorkerError } from '@/hooks/use-worker-error'
import { useStageTiles } from '@/hooks/use-stage-tiles'
import { useChatDetail } from '@/hooks/use-chat-detail'
import { useChatHistory } from '@/hooks/use-chat-history'
import { cn } from '@/lib/utils'

declare global {
  interface Window {
    __sendText?: (text: string) => void
  }
}

interface ChatRoomInteriorProps {
  onDisconnect: () => void
  chatId: string
}

function toOrbState(state: string | undefined): OrbState {
  if (state === 'listening' || state === 'pre-connect-buffering') return 'listening'
  if (state === 'thinking' || state === 'connecting' || state === 'initializing') return 'thinking'
  if (state === 'speaking') return 'talking'
  return null
}

export function ChatRoomInterior({ onDisconnect, chatId }: ChatRoomInteriorProps) {
  const { state: agentState } = useVoiceAssistant()
  const { send } = useChat()
  const workerError = useWorkerError()
  const [transcriptOpen, setTranscriptOpen] = useState(true)
  const [swapped, setSwapped] = useState(false)
  const queryClient = useQueryClient()

  const { data: messages = [] } = useChatHistory(chatId)

  // Append messages to cache when voice agent signals via LiveKit data channel.
  // Uses setQueryData (no HTTP round-trip) mirroring the artifact_ready pattern.
  // Each stream carries a MessageAdded JSON payload with the full message row.
  const { textStreams: msgSignals } = useTextStream('message_added')
  const msgSignalProcessedRef = useRef(0)
  useEffect(() => {
    const unprocessed = msgSignals.slice(msgSignalProcessedRef.current)
    if (unprocessed.length === 0) return
    for (const stream of unprocessed) {
      let parsed: ReturnType<typeof MessageAdded.safeParse>
      try {
        parsed = MessageAdded.safeParse(JSON.parse(stream.text))
      } catch {
        // Partial chunk — wait for next textStreams update
        break
      }
      if (!parsed.success) {
        msgSignalProcessedRef.current++
        continue
      }
      msgSignalProcessedRef.current++
      const msg = parsed.data
      // setQueryData writes directly to the React Query cache — no network call.
      // This is external cache mutation (not React state), same pattern as artifact_ready.
      queryClient.setQueryData<MessageRowType[]>(['chat-history', chatId], (old) => {
        const existing = old ?? []
        // Dedup by ID in case the signal fires more than once (reconnect, retry)
        if (existing.some((m) => m.id === msg.id)) return existing
        return [...existing, msg]
      })
    }
  }, [msgSignals, chatId, queryClient])

  const { tiles, setActive } = useStageTiles(chatId)
  const { data: chatDetail } = useChatDetail(chatId)
  const stageMode = chatDetail?.stageMode ?? false
  const hasArtifact = tiles.length > 0

  useEffect(() => {
    window.__sendText = (text: string) => void send(text)
    return () => { window.__sendText = undefined }
  }, [send])

  const orbNode = (
    <div className="flex h-full items-center justify-center">
      <div className="aspect-square h-64 max-h-[80%]">
        <Orb agentState={toOrbState(agentState)} />
      </div>
    </div>
  )

  const stageNode = hasArtifact
    ? <StageRenderer tiles={tiles} onActivate={setActive} stageMode={stageMode} />
    : null

  // Main stage content: stage manager (or orb if no tiles / swapped)
  const showStageAsMain = hasArtifact && !swapped
  const mainContent = showStageAsMain ? stageNode : orbNode

  // PiP content: only shown when there's at least one tile
  const pipContent = hasArtifact
    ? (swapped ? stageNode : <div className="h-full w-full scale-90">{orbNode}</div>)
    : null

  return (
    <div className="flex h-full max-h-full overflow-hidden bg-muted/30">
      <RoomAudioRenderer />

      {/* Left: main stage + controls */}
      <div className="relative flex-1 min-w-0 p-3 pb-20">
        {workerError && (
          <div data-testid="worker-error-banner" className="absolute top-0 inset-x-0 z-30 bg-destructive text-destructive-foreground px-4 py-2 text-sm">
            {workerError}
          </div>
        )}

        {/* Main stage tile */}
        <div className="relative h-full overflow-hidden rounded-lg border border-border bg-background shadow-sm">
          <StageTile>{mainContent}</StageTile>

          {/* PiP tile — only when an artifact tile exists */}
          {pipContent && (
            <div className="absolute bottom-3 right-3 z-10">
              <StageTile pip onSwap={() => setSwapped((s) => !s)}>
                {pipContent}
              </StageTile>
            </div>
          )}
        </div>

        {/* Floating control bar + transcript toggle */}
        <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2">
          <AgentControlBar
            variant="livekit"
            isConnected
            isChatOpen={false}
            controls={{ microphone: true, screenShare: true, chat: false, leave: true }}
            onDisconnect={onDisconnect}
          />
          <button
            type="button"
            onClick={() => setTranscriptOpen((v) => !v)}
            aria-label="Toggle transcript"
            className={cn(
              'rounded-full border p-2.5 transition-colors',
              transcriptOpen
                ? 'bg-accent text-foreground border-border'
                : 'bg-background text-muted-foreground border-border hover:bg-accent',
            )}
          >
            <MessageSquareText className="h-4 w-4" />
          </button>
          <StageModeToggle chatId={chatId} />
        </div>
      </div>

      {/* Right: transcript sidebar with chat input */}
      {transcriptOpen && (
        <div data-testid="transcript" className="flex w-64 shrink-0 flex-col border-l border-border bg-background">
          <AgentChatTranscript
            agentState={agentState}
            messages={messages}
            className="flex-1 min-h-0"
          />
          <TranscriptChatInput />
        </div>
      )}
    </div>
  )
}

function TranscriptChatInput() {
  const { send } = useChat()
  const [message, setMessage] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSend = () => {
    const trimmed = message.trim()
    if (!trimmed) return
    void send(trimmed)
    setMessage('')
    inputRef.current?.focus()
  }

  return (
    <div className="flex items-center gap-1.5 border-t border-border p-2">
      <input
        ref={inputRef}
        type="text"
        value={message}
        placeholder="Type something..."
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleSend() }}
        data-testid="conversation-input"
        className="flex-1 min-w-0 rounded-md bg-muted/50 px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none"
      />
      <button
        type="button"
        disabled={!message.trim()}
        onClick={handleSend}
        data-testid="conversation-send"
        className="rounded-md p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
      >
        <SendHorizontal className="h-4 w-4" />
      </button>
    </div>
  )
}
