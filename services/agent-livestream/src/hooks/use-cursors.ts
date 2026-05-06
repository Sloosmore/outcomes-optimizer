import { useEffect, useMemo, useState } from 'react'
import type { AgentEvent } from '@skill-networks/agent-events'
import { streamAdapter, historyAdapter } from '@/config'

export type CursorPosition = {
  process_id: string
  process_name: string
  resource_id: string | null
  updatedAt: number
}

const CURSOR_TTL_MS = 5 * 60 * 1000 // evict cursors idle for 5 minutes
const CURSOR_EVICT_INTERVAL_MS = 60 * 1000

export function useCursors(): Omit<CursorPosition, 'updatedAt'>[] {
  const [cursors, setCursors] = useState<Map<string, CursorPosition>>(new Map())

  useEffect(() => {
    // Load initial positions from history.
    // Use functional update so realtime events that arrived during the async load are not lost.
    historyAdapter.getHistory(100).then((events) => {
      setCursors((prev) => {
        const next = new Map(prev)
        // Events come in DESC order (newest first) — only backfill, don't overwrite realtime updates
        for (const e of events) {
          if (!next.has(e.process_id)) {
            next.set(e.process_id, {
              process_id: e.process_id,
              process_name: e.process_name,
              resource_id: e.resource_id,
              updatedAt: Date.now(),
            })
          }
        }
        return next
      })
    }).catch(() => {
      // silently ignore history load failures
    })

    // Subscribe to real-time updates
    const unsubscribe = streamAdapter.subscribe((event: AgentEvent) => {
      setCursors((prev) => {
        const next = new Map(prev)
        next.set(event.process_id, {
          process_id: event.process_id,
          process_name: event.process_name,
          resource_id: event.resource_id,
          updatedAt: Date.now(),
        })
        return next
      })
    })

    // Periodically evict cursors for processes that have gone silent
    const evictId = setInterval(() => {
      const cutoff = Date.now() - CURSOR_TTL_MS
      setCursors((prev) => {
        let changed = false
        const next = new Map(prev)
        for (const [id, cursor] of next) {
          if (cursor.updatedAt < cutoff) {
            next.delete(id)
            changed = true
          }
        }
        return changed ? next : prev
      })
    }, CURSOR_EVICT_INTERVAL_MS)

    return () => {
      unsubscribe()
      clearInterval(evictId)
    }
  }, [])

  return useMemo(
    () => Array.from(cursors.values()).map(({ updatedAt: _updatedAt, ...rest }) => rest),
    [cursors],
  )
}
