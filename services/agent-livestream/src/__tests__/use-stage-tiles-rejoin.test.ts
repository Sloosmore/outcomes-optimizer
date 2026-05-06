// @vitest-environment jsdom
/**
 * Verifies the rejoin-fix in use-stage-tiles.ts:
 * Every transition INTO the LiveKit "connected" state must invalidate the
 * chat-detail React Query so the rail re-fetches persisted tiles. Without
 * this, the stage manager keeps rendering the pre-leave snapshot after a
 * user ends the call and rejoins — even though the server has the new tile.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Mutable mock state — flipped per test to simulate connection transitions.
let mockConnectionState = 'disconnected'
let mockChatDetail: { artifactTiles: { url: string }[] } | undefined

vi.mock('../hooks/use-conversation.js', () => ({
  useTextStream: () => ({ textStreams: [] }),
  useConnectionState: () => mockConnectionState,
}))

vi.mock('../hooks/use-chat-detail', () => ({
  useChatDetail: () => ({ data: mockChatDetail }),
}))

vi.mock('../lib/api-fetch', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
}))

import { useStageTiles } from '../hooks/use-stage-tiles'

function wrap(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children)
}

describe('useStageTiles — rejoin invalidation', () => {
  beforeEach(() => {
    mockConnectionState = 'disconnected'
    mockChatDetail = { artifactTiles: [] }
  })

  it('does NOT invalidate on initial connect (avoids racing optimistic mutations)', () => {
    const client = new QueryClient()
    const spy = vi.spyOn(client, 'invalidateQueries')

    const { rerender } = renderHook(() => useStageTiles('chat-1'), { wrapper: wrap(client) })
    expect(spy).not.toHaveBeenCalled()

    mockConnectionState = 'connecting'
    rerender()
    mockConnectionState = 'connected'
    rerender()
    // useChatDetail covers the initial fetch. An invalidate here would clobber
    // any optimistic write the user just made (e.g. flipping stage_mode just
    // before joining).
    expect(spy).not.toHaveBeenCalled()
  })

  it('invalidates on a true rejoin (connected → disconnected → connected)', () => {
    const client = new QueryClient()
    const spy = vi.spyOn(client, 'invalidateQueries')

    mockConnectionState = 'connected'
    const { rerender } = renderHook(() => useStageTiles('chat-2'), { wrapper: wrap(client) })
    expect(spy).not.toHaveBeenCalled() // initial connect is silent

    mockConnectionState = 'disconnected'
    rerender()
    mockConnectionState = 'connected'
    rerender()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenLastCalledWith({ queryKey: ['chat', 'chat-2'] })
  })

  it('invalidates on every subsequent rejoin', () => {
    const client = new QueryClient()
    const spy = vi.spyOn(client, 'invalidateQueries')

    mockConnectionState = 'connected'
    const { rerender } = renderHook(() => useStageTiles('chat-3'), { wrapper: wrap(client) })

    // 1st rejoin
    mockConnectionState = 'disconnected'; rerender()
    mockConnectionState = 'connected'; rerender()
    expect(spy).toHaveBeenCalledTimes(1)

    // 2nd rejoin
    mockConnectionState = 'disconnected'; rerender()
    mockConnectionState = 'connected'; rerender()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('does not re-invalidate while staying connected', () => {
    const client = new QueryClient()
    const spy = vi.spyOn(client, 'invalidateQueries')

    mockConnectionState = 'connected'
    const { rerender } = renderHook(() => useStageTiles('chat-4'), { wrapper: wrap(client) })
    rerender()
    rerender()
    expect(spy).not.toHaveBeenCalled()
  })
})
