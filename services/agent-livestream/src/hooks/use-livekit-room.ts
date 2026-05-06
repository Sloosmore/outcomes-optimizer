import { useState, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { TokenResponse } from '@skill-networks/contracts/chat'
import { apiFetch } from '@/lib/api-fetch'

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'ended'

interface UseLiveKitRoomOptions {
  chatId: string
  /**
   * Project the user is viewing in the top bar — forwarded to /token so the
   * voice-tool JWT carries it as a claim, which the dispatch tool then uses
   * to land new skills in this project instead of the per-user fallback.
   * Optional; omit to keep the legacy `project:<userId>` behavior.
   */
  activeProjectName?: string
}

function msUntilRefresh(expiresAt: string): number {
  const expiryMs = new Date(expiresAt).getTime()
  const now = Date.now()
  // Refresh 5 minutes before expiry, minimum 10 seconds
  return Math.max(expiryMs - now - 5 * 60_000, 10_000)
}

export function useLiveKitRoom({ chatId, activeProjectName }: UseLiveKitRoomOptions) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle')
  const queryClient = useQueryClient()

  const { data: tokenData } = useQuery({
    // activeProjectName is part of the key so a project switch invalidates
    // the cached token and forces a fresh /token call (which re-mints the
    // voice-tool JWT with the new project claim).
    queryKey: ['livekit-token', chatId, activeProjectName ?? null],
    queryFn: async () => {
      // apiFetch attaches the Supabase Authorization header so the BFF can mint
      // voiceToolJwt and pre-create the LiveKit room with it in metadata.
      // Without the auth header, voiceToolJwt is never generated and the deployed
      // voice agent falls back to the research BFF instead of per-sandbox execution.
      const params = new URLSearchParams({ chatId })
      if (activeProjectName) params.set('activeProject', activeProjectName)
      const res = await apiFetch(`/token?${params.toString()}`)
      if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`)
      const json: unknown = await res.json()
      return TokenResponse.parse(json)
    },
    enabled: connectionState === 'connecting' || connectionState === 'connected',
    refetchInterval: (query) => {
      const expiresAt = query.state.data?.expiresAt
      if (!expiresAt) return false
      return msUntilRefresh(expiresAt)
    },
    // Always refetch on (re)mount/(re)enable. Each call to /token also runs
    // AgentDispatchClient.createDispatch on the BFF — without a fresh fetch on
    // rejoin the agent worker never re-enters the room and prompts go to a
    // room with no agent in it. staleTime:0 + refetchOnMount:'always' is the
    // belt-and-suspenders combo that survives both React Query staleness and
    // observer caching.
    staleTime: 0,
    refetchOnMount: 'always',
  })

  const serverUrl = import.meta.env.VITE_LIVEKIT_URL as string | undefined

  const handleConnect = useCallback(() => {
    // Drop the cached token so the next render fetches fresh. Each /token call
    // also runs AgentDispatchClient.createDispatch on the BFF — without a new
    // fetch on rejoin the worker never re-enters the room and prompts go to a
    // room with no agent in it. removeQueries (not invalidateQueries) prevents
    // LiveKitRoom from mounting briefly with the stale token before the new
    // one arrives, which would skip the dispatch entirely.
    queryClient.removeQueries({ queryKey: ['livekit-token', chatId] })
    setConnectionState('connecting')
  }, [chatId, queryClient])

  const handleConnected = useCallback(() => {
    setConnectionState('connected')
  }, [])

  const handleDisconnected = useCallback(() => {
    setConnectionState('ended')
  }, [])

  return {
    token: tokenData?.token ?? null,
    expiresAt: tokenData?.expiresAt ?? null,
    serverUrl: serverUrl ?? null,
    connectionState,
    setConnectionState,
    handleConnect,
    handleConnected,
    handleDisconnected,
  }
}
