import { useSyncExternalStore, useMemo } from 'react'
import { streamAdapter } from '@/config'
import type { AgentEvent } from '@skill-networks/agent-events'

const MAX_EVENTS = 30

// Module-level singleton — shared subscription across all consumers.
// useSyncExternalStore drives re-renders; no setState needed.
let storedEvents: AgentEvent[] = []
const listeners = new Set<() => void>()
let unsubStream: (() => void) | null = null

function notify() {
  for (const fn of listeners) fn()
}

function subscribeToStore(fn: () => void): () => void {
  if (listeners.size === 0) {
    unsubStream = streamAdapter.subscribe((event) => {
      storedEvents = [event, ...storedEvents].slice(0, MAX_EVENTS)
      notify()
    })
  }
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0) {
      unsubStream?.()
      unsubStream = null
      storedEvents = []
    }
  }
}

function getSnapshot(): AgentEvent[] {
  return storedEvents
}

export function useAgentEvents(processId: string | null): AgentEvent[] {
  const allEvents = useSyncExternalStore(subscribeToStore, getSnapshot)
  return useMemo(
    () => (processId ? allEvents.filter((e) => e.process_id === processId) : []),
    [allEvents, processId],
  )
}

/**
 * Polls the BFF for the latest event per process.
 * Fallback for when the Supabase realtime channel fails to connect
 * (e.g. MagicLinkSessionAdapter.signIn() requires email+code).
 */
export { usePolledLatestEvents } from './use-polled-latest-events'
