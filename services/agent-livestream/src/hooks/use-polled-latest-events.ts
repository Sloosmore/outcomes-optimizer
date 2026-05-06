import { useMemo, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api-fetch'
import { useProjectUuid } from '@/hooks/use-project'
import { getSubscribe, getSnapshot, NO_OP_SUBSCRIBE, EMPTY_SNAPSHOT } from '@/lib/sse-cursor-store'
import type { CursorList } from '@/hooks/use-cursor-nodes'

interface LatestEvent {
  source: string
}

// Stable empty fallback — hoisted so `polledData ?? EMPTY_LATEST_EVENTS` returns
// the same reference every render, avoiding unnecessary downstream re-renders.
const EMPTY_LATEST_EVENTS: Map<string, string> = new Map()

/**
 * Returns a Map<process_id, source_string> of the most recent event per process.
 *
 * Strategy:
 * - When projectUuid is available: opens one fetch-based SSE connection to
 *   /api/events?projectId=<uuid> and filters events client-side by process_id.
 *   Uses Authorization: Bearer header via apiFetch (JWT middleware requires header,
 *   not query param).
 * - Falls back to React Query N+1 polling when projectUuid is empty/unavailable
 *   or when the SSE connection enters error state.
 */
export function usePolledLatestEvents(
  cursorMap: Map<string, CursorList>,
): Map<string, string> {
  const projectUuid = useProjectUuid()

  // Flatten all process IDs from the cursor map
  const processIds = useMemo(() => {
    const ids: string[] = []
    for (const cursors of cursorMap.values()) {
      for (const c of cursors) ids.push(c.process_id)
    }
    return ids
  }, [cursorMap])

  // Stable sorted key — prevents full query invalidation on cursor add/remove ordering changes
  const stableKey = useMemo(() => [...processIds].sort().join(','), [processIds])

  // Derive Set from stableKey (the sorted string) so the factory and its deps
  // reference the same canonical value — no lint suppression required.
  const processIdSet = useMemo(
    () => new Set(stableKey ? stableKey.split(',') : []),
    [stableKey],
  )

  // SSE path — one connection per projectUuid via useSyncExternalStore.
  // Uses NO_OP_SUBSCRIBE/EMPTY_SNAPSHOT when projectUuid is unavailable to
  // avoid opening a doomed connection to an invalid projectId.
  const sseState = useSyncExternalStore(
    projectUuid ? getSubscribe(projectUuid) : NO_OP_SUBSCRIBE,
    projectUuid ? getSnapshot(projectUuid) : EMPTY_SNAPSHOT,
    projectUuid ? getSnapshot(projectUuid) : EMPTY_SNAPSHOT,
  )

  // Polling fallback — active when projectUuid unavailable or SSE in error state
  const usePollFallback = !projectUuid || sseState.errorState
  const { data: polledData } = useQuery({
    queryKey: ['latest-events', stableKey],
    queryFn: async () => {
      const results = new Map<string, string>()
      await Promise.all(processIds.map(async (pid) => {
        try {
          const r = await apiFetch(`/api/process-events/${pid}?limit=1`)
          if (!r.ok) return
          const body = await r.json() as { events?: LatestEvent[] }
          const events = body.events ?? []
          if (events.length > 0) {
            results.set(pid, events[0].source)
          }
        } catch {
          // Ignore individual fetch failures
        }
      }))
      return results
    },
    enabled: usePollFallback && processIds.length > 0,
    refetchInterval: 5_000,
    placeholderData: (prev) => prev,
  })

  // Filter SSE events to only known process IDs — memoized so the returned
  // Map reference is stable when the underlying data hasn't changed.
  // Depends on sseState (the outer snapshot object, which is replaced on each
  // rebuildSnapshot call) rather than sseState.latestEvents (which is the same
  // Map reference mutated in place — a stable ref would prevent recomputation).
  const sseFiltered = useMemo(() => {
    // Short-circuit when fallback is active — result is unused and the iteration
    // over the SSE Map would be wasted work.
    if (usePollFallback) return EMPTY_LATEST_EVENTS
    const result = new Map<string, string>()
    for (const [pid, source] of sseState.latestEvents) {
      if (processIdSet.has(pid)) {
        result.set(pid, source)
      }
    }
    return result
  }, [usePollFallback, sseState, processIdSet])

  // Return SSE-filtered events or polling fallback
  if (usePollFallback) {
    return polledData ?? EMPTY_LATEST_EVENTS
  }

  return sseFiltered
}
