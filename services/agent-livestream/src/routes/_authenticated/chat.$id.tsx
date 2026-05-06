/* eslint-disable react-refresh/only-export-components -- TanStack Router route files export Route (a config object) alongside the page component */
import { useCallback, useMemo } from 'react'
import { createFileRoute, useParams } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { ApiOrgResponse } from '@skill-networks/contracts/org'
import { ORG_STALE_TIME_MS } from '@/constants'
import {
  LiveKitRoom,
  SessionProvider,
  useRoomContext,
  useSession,
  TokenSource,
  MediaDeviceFailure,
} from '../../hooks/use-conversation.js'
import { Orb } from '@/components/ui/elevenlabs-orb'
import { ChatRoomInterior } from '@/components/chat-room-interior'
import { useLiveKitRoom } from '@/hooks/use-livekit-room'
import { useSoundEffects } from '@/hooks/use-sound-effects'
import { useChatHistory } from '@/hooks/use-chat-history'
import { useChatDetail } from '@/hooks/use-chat-detail'
import { ChatDetail } from '@skill-networks/contracts/chat'
import type { QueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api-fetch'

function chatDetailQueryOptions(id: string) {
  return {
    queryKey: ['chat', id] as const,
    queryFn: async () => {
      const res = await apiFetch(`/api/chats/${id}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: unknown = await res.json()
      return ChatDetail.parse(json)
    },
    staleTime: 30_000,
  }
}

export const Route = createFileRoute('/_authenticated/chat/$id')({
  component: ChatPage,
  // Pre-fetch chat detail so artifact-iframe renders immediately on load/reload
  loader: async ({ context, params }: { context: { queryClient: QueryClient }; params: { id: string } }) => {
    await context.queryClient.prefetchQuery(chatDetailQueryOptions(params.id))
  },
})

// Bridges LiveKitRoom (old connection API) with SessionProvider (new agents-ui API).
// AgentControlBar and related hooks require useSessionContext(), which needs SessionProvider.
function WithSession({ token, serverUrl, children }: { token: string; serverUrl: string; children: React.ReactNode }) {
  const room = useRoomContext()
  const tokenSource = useMemo(
    // TokenSourceResponseObject is a protobuf-derived type; { url, authToken } is the correct shape
    // but TypeScript cannot infer it from ConstructorParameters — cast to any to satisfy the overload
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => TokenSource.literal({ url: serverUrl, authToken: token } as any),
    // tokenSource only needs to be stable — token/serverUrl won't change while connected
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const session = useSession(tokenSource, { room })
  return <SessionProvider session={session}>{children}</SessionProvider>
}

function ChatPage() {
  const { id } = Route.useParams()

  // Active project mirrors what the OrgSwitcher in app-top-bar shows:
  // (1) project name from /p/$projectName URL params if we got here from a project view,
  // (2) otherwise the first project in the user's org list (matches the
  //     `projects[0]` fallback in OrgSwitcher when no projectName param exists).
  // Forwarded to /token so dispatched skills land in this project rather than
  // the per-user `project:<userId>` fallback.
  const urlParams = useParams({ strict: false }) as { projectName?: string }
  const { data: orgData } = useQuery<ApiOrgResponse>({
    queryKey: ['org'],
    queryFn: () => apiFetch('/api/org').then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }),
    staleTime: ORG_STALE_TIME_MS,
    placeholderData: (prev) => prev,
  })
  const activeProjectName = urlParams.projectName ?? orgData?.projects?.[0]?.name

  const {
    token,
    serverUrl,
    connectionState,
    handleConnect,
    handleConnected,
    handleDisconnected,
  } = useLiveKitRoom({ chatId: id, activeProjectName })
  const { play, startLoop, stopLoop } = useSoundEffects()

  const onJoin = useCallback(() => {
    startLoop()
    handleConnect()
  }, [startLoop, handleConnect])

  const onConnected = useCallback(() => {
    stopLoop()
    play('toggleOn')
    handleConnected()
  }, [stopLoop, play, handleConnected])

  const onDisconnected = useCallback(() => {
    stopLoop()
    play('toggleOff')
    handleDisconnected()
  }, [stopLoop, play, handleDisconnected])

  const { data: chatHistory = [] } = useChatHistory(id)
  const { data: chatDetail } = useChatDetail(id)
  const artifactTiles = chatDetail?.artifactTiles ?? []
  const previewUrl = artifactTiles[0]?.url ?? null
  const buttonLabel = chatHistory.length > 0 || connectionState === 'ended' ? 'Rejoin' : 'Join'

  if (connectionState === 'idle' || connectionState === 'ended') {
    return (
      <div data-connection-state={connectionState} className="flex h-full flex-col items-center justify-center gap-6">
        <div className="aspect-square h-56">
          <Orb agentState={null} />
        </div>
        {chatHistory.length > 0 && (
          <ul className="max-h-48 w-full max-w-sm overflow-y-auto rounded-lg border bg-card p-3 text-sm">
            {chatHistory.map((msg) => (
              <li key={msg.id} className="mb-1">
                <span className="font-semibold capitalize text-muted-foreground">{msg.role}: </span>
                {msg.content}
              </li>
            ))}
          </ul>
        )}
        {previewUrl !== null && (
          <div className="h-64 w-full max-w-2xl border-t mt-4">
            <iframe
              data-testid="artifact-frame"
              src={previewUrl}
              className="h-full w-full border-0"
              title="Research artifact"
              sandbox="allow-scripts allow-same-origin allow-forms"
            />
          </div>
        )}
        <button
          type="button"
          onClick={onJoin}
          className="rounded-full bg-primary px-8 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          {buttonLabel}
        </button>
      </div>
    )
  }

  if (!token || !serverUrl) {
    return (
      <div data-connection-state={connectionState} className="flex h-full items-center justify-center">
        <div className="aspect-square h-56">
        <Orb agentState="thinking" />
      </div>
      </div>
    )
  }

  return (
    <LiveKitRoom
      data-connection-state={connectionState}
      serverUrl={serverUrl}
      token={token}
      audio
      video={false}
      connect
      onConnected={onConnected}
      onDisconnected={onDisconnected}
      onError={(err) => {
        console.error('LiveKit error:', err)
        // Ignore media device failures (mic/camera not available) — text still works
        const isMicError = MediaDeviceFailure.getFailure(err) !== undefined
          || (err instanceof Error && (err.name === 'NotSupportedError' || err.name === 'NotFoundError' || err.name === 'NotAllowedError'))
        if (!isMicError) onDisconnected()
      }}
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      <WithSession token={token} serverUrl={serverUrl}>
        <ChatRoomInterior onDisconnect={onDisconnected} chatId={id} />
      </WithSession>
    </LiveKitRoom>
  )
}
