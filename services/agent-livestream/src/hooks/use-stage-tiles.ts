import { useEffect, useRef, useCallback } from 'react'
import { useTextStream, useConnectionState } from './use-conversation.js'
import { useQueryClient } from '@tanstack/react-query'
import { ArtifactReady } from '@skill-networks/contracts/livekit'
import { ARTIFACT_TILES_MAX, type ArtifactTile, type ChatDetail } from '@skill-networks/contracts/chat'
import { apiFetch } from '@/lib/api-fetch'
import { useChatDetail } from './use-chat-detail'

interface UseStageTilesResult {
  /** Ordered tile rail. Index 0 = active. */
  tiles: ArtifactTile[]
  /** Promote an existing rail URL to index 0. Optimistic via cache + POST. */
  setActive: (url: string) => void
}

/**
 * Single source of truth for the artifact rail.
 *
 * Reads `chatDetail.artifactTiles` from React Query so reload-restore is free.
 * Subscribes to the `artifact_ready` text stream and PATCHes new URLs onto the
 * rail; the server dedupes + caps. After each mutation, invalidates the chat
 * query so the cache reflects the persisted state.
 *
 * `setActive` POSTs to `/artifact/activate`, also followed by an invalidation.
 */
export function useStageTiles(chatId: string): UseStageTilesResult {
  const { data: chatDetail } = useChatDetail(chatId)
  const tiles = chatDetail?.artifactTiles ?? []
  const queryClient = useQueryClient()

  const { textStreams } = useTextStream('artifact_ready')
  const processedCountRef = useRef<number>(0)

  // After leaving and rejoining a room, the chat-room-interior subtree unmounts
  // and remounts. The chat-detail React Query stays in cache (within staleTime)
  // and is reused as-is on remount, so any tiles persisted while we were gone
  // (e.g. an artifact_ready that fired during the rejoin window) never make it
  // into the UI until a hard refresh. Force a refetch on a true REJOIN — i.e.
  // only when we were previously connected and disconnected at least once.
  // Skipping the initial connect avoids racing with concurrent optimistic
  // mutations (e.g. the stage-mode toggle the user flipped just before joining):
  // an unconditional invalidate on first connect would refetch stale server
  // state and clobber the optimistic cache write.
  const connectionState = useConnectionState()
  const seenConnectedRef = useRef<boolean>(false)
  const seenDisconnectRef = useRef<boolean>(false)
  useEffect(() => {
    const state = String(connectionState)
    if (state === 'disconnected' && seenConnectedRef.current) {
      seenDisconnectRef.current = true
    }
    if (state === 'connected') {
      const isRejoin = seenConnectedRef.current && seenDisconnectRef.current
      seenConnectedRef.current = true
      if (isRejoin) {
        // Reset processed-count alongside the cache reset — the new room session
        // starts with an empty textStreams buffer, so existing entries we already
        // processed are gone and the next event lives at index 0.
        processedCountRef.current = 0
        seenDisconnectRef.current = false
        void queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
      }
    }
  }, [connectionState, chatId, queryClient])

  useEffect(() => {
    const unprocessed = textStreams.slice(processedCountRef.current)
    if (unprocessed.length === 0) return

    for (const stream of unprocessed) {
      let parsed: ReturnType<typeof ArtifactReady.safeParse>
      try {
        parsed = ArtifactReady.safeParse(JSON.parse(stream.text))
      } catch {
        // JSON.parse failed — entry is malformed and will never parse; skip it.
        processedCountRef.current++
        continue
      }
      if (!parsed.success) {
        processedCountRef.current++
        continue
      }
      // Increment before the url guard: the count tracks stream entries consumed,
      // not tiles added. A valid-schema but URL-less entry is consumed (won't
      // be retried) but produces no tile — this is intentional.
      processedCountRef.current++

      const { url, stageMode } = parsed.data
      // Skip entries with neither URL nor stageMode — nothing to apply.
      if (!url && !stageMode) continue
      // eslint-disable-next-line no-console -- Browser bundle has no structured logger; latency-trace instrumentation.
      console.info('[stage-tiles] artifact_ready received', {
        url: url ? url.slice(0, 80) : null,
        stageMode: stageMode ?? null,
        t_ms: performance.now(),
      })

      // Optimistic write — promote URL to index 0 (active main stage) AND/OR
      // flip stageMode. Either or both fields apply per event. The server-side
      // PATCH (below for url, share_screen tool's PATCH /stage-mode for mode)
      // reconciles via on-settle invalidate; this write just makes the swap
      // land on the next paint instead of waiting for the refetch.
      queryClient.setQueryData<ChatDetail>(['chat', chatId], (old) => {
        if (!old) return old
        let nextDetail = old
        if (url) {
          const filtered = old.artifactTiles.filter((t) => t.url !== url)
          const nextTiles: ArtifactTile[] = [{ url }, ...filtered].slice(0, ARTIFACT_TILES_MAX)
          nextDetail = { ...nextDetail, artifactTiles: nextTiles }
        }
        if (stageMode) {
          // 'spotlight' → multi-tile rail (true); 'focus' → single full-bleed (false).
          nextDetail = { ...nextDetail, stageMode: stageMode === 'spotlight' }
        }
        return nextDetail
      })

      // No URL on this event — stageMode-only signal, nothing to PATCH.
      if (!url) continue

      const patchStart = performance.now()
      apiFetch(`/api/chats/${chatId}/artifact`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, port: parsed.data.port }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.text().catch(() => '<unreadable>')
            // eslint-disable-next-line no-console -- Browser bundle has no structured logger; error reporting only.
            console.error('[stage-tiles] PATCH non-2xx', { chatId, status: res.status, body: body.slice(0, 200) })
            // Revert: refetch from server so a failed PATCH doesn't leave the
            // cache showing a tile that was never persisted.
            await queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
            return
          }
          // eslint-disable-next-line no-console -- Latency trace.
          console.info('[stage-tiles] PATCH ok', { dt_ms: Math.round(performance.now() - patchStart) })
          // Reconcile: refetch so the cache matches whatever the server actually
          // stored (handles dedupe, cap, server-side ordering quirks). The
          // optimistic write already mounted the iframe.
          await queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
        })
        .catch(async (err) => {
          // eslint-disable-next-line no-console -- Browser bundle has no structured logger; error reporting only.
          console.error('[stage-tiles] PATCH failed', {
            chatId,
            err: err instanceof Error ? err.message : String(err),
          })
          // Revert optimistic write on network error too — same as non-2xx path.
          await queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
        })
    }
  }, [textStreams, chatId, queryClient])

  const setActive = useCallback((url: string) => {
    void apiFetch(`/api/chats/${chatId}/artifact/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text().catch(() => '<unreadable>')
          // eslint-disable-next-line no-console -- Browser bundle has no structured logger; error reporting only.
          console.error('[stage-tiles] activate non-2xx', { chatId, status: res.status, body: body.slice(0, 200) })
          return
        }
        await queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
      })
      .catch((err) => {
        // eslint-disable-next-line no-console -- Browser bundle has no structured logger; error reporting only.
        console.error('[stage-tiles] activate failed', {
          chatId,
          err: err instanceof Error ? err.message : String(err),
        })
      })
  }, [chatId, queryClient])

  return { tiles, setActive }
}
