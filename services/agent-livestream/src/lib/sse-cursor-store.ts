import { apiFetch } from '@/lib/api-fetch'
import { SseEventFrameSchema } from '@contracts/sse-event-frame'

// ---------------------------------------------------------------------------
// Module-level SSE store — one connection per projectUuid.
// Uses useSyncExternalStore pattern (same as use-agent-events.ts) so no
// setState is called inside useEffect.
// ---------------------------------------------------------------------------

// Shared stable empty state — returned by getSseSnapshot when no entry exists.
// Module-level constant so useSyncExternalStore sees the same reference every time.
const EMPTY_STATE: { latestEvents: Map<string, string>; errorState: boolean } = Object.freeze({
  latestEvents: new Map<string, string>(),
  errorState: false,
})

type SseStoreEntry = {
  latestEvents: Map<string, string>
  listeners: Set<() => void>
  abortController: AbortController | null
  errorState: boolean
  // Cached snapshot — only rebuilt when latestEvents or errorState changes.
  // useSyncExternalStore compares via Object.is; returning a new object every call
  // causes React to treat the store as "changed" on every render (render loop).
  snapshot: { latestEvents: Map<string, string>; errorState: boolean }
}

const sseStore = new Map<string, SseStoreEntry>()

function getOrCreateEntry(projectUuid: string): SseStoreEntry {
  let entry = sseStore.get(projectUuid)
  if (!entry) {
    const latestEvents = new Map<string, string>()
    entry = {
      latestEvents,
      listeners: new Set(),
      abortController: null,
      errorState: false,
      // Share the same latestEvents ref in the initial snapshot — belt-and-suspenders
      // alongside the errorState guard in startSseConnection. The primary fix for the
      // render loop is that guard; this just avoids an unnecessary rebuildSnapshot call
      // on fresh entries where errorState was already false.
      snapshot: { latestEvents, errorState: false },
    }
    sseStore.set(projectUuid, entry)
  }
  return entry
}

function rebuildSnapshot(entry: SseStoreEntry): void {
  // Clone latestEvents so each snapshot is a fully immutable value — required by
  // the useSyncExternalStore contract. A mutable Map shared across snapshots would
  // satisfy Object.is tearing detection (outer object changes) but violates the
  // contract and could produce inconsistent reads under concurrent rendering.
  entry.snapshot = { latestEvents: new Map(entry.latestEvents), errorState: entry.errorState }
}

function notifyListeners(projectUuid: string): void {
  const entry = sseStore.get(projectUuid)
  if (!entry) return
  for (const fn of entry.listeners) fn()
}

function startSseConnection(projectUuid: string): void {
  const entry = getOrCreateEntry(projectUuid)
  if (entry.abortController) return // already running

  const controller = new AbortController()
  entry.abortController = controller
  // Only rebuild snapshot if errorState actually changed — avoids creating a
  // new snapshot object during subscribe that triggers useSyncExternalStore
  // torn-read detection and synchronous re-render loops.
  if (entry.errorState) {
    entry.errorState = false
    rebuildSnapshot(entry)
  }

  void (async () => {
    try {
      const response = await apiFetch(`/api/events?projectId=${projectUuid}`, {
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        const current = sseStore.get(projectUuid)
        if (current) {
          current.errorState = true
          current.abortController = null
          rebuildSnapshot(current)
        }
        notifyListeners(projectUuid)
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Parse SSE frames — frames are separated by double newline
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''

        for (const frame of parts) {
          for (const line of frame.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                const raw: unknown = JSON.parse(line.slice(6))
                const parsed = SseEventFrameSchema.safeParse(raw)
                if (parsed.success) {
                  const current = sseStore.get(projectUuid)
                  if (current) {
                    // Encode token count into value string for token_usage events
                    // so the cursor animation can scale impulse by token amount.
                    // Format: "token_usage:1234" — parsed in use-cursor-animation.ts
                    const value = parsed.data.tokens != null
                      ? `${parsed.data.source}:${parsed.data.tokens}`
                      : parsed.data.source
                    current.latestEvents.set(parsed.data.process_id, value)
                    rebuildSnapshot(current)
                    notifyListeners(projectUuid)
                  }
                }
              } catch {
                // ignore parse errors — malformed frames are non-fatal
              }
            }
          }
        }
      }
    } catch {
      // AbortError on cleanup is expected; all other errors mark error state
    } finally {
      const current = sseStore.get(projectUuid)
      if (current && current.abortController === controller) {
        if (!controller.signal.aborted) {
          current.errorState = true
          rebuildSnapshot(current)
        }
        current.abortController = null
        notifyListeners(projectUuid)
      }
    }
  })()
}

function stopSseConnection(projectUuid: string): void {
  const entry = sseStore.get(projectUuid)
  if (!entry) return
  if (entry.abortController) {
    entry.abortController.abort()
    entry.abortController = null
  }
}

function subscribeSseStore(projectUuid: string): (fn: () => void) => () => void {
  return (fn: () => void) => {
    const entry = getOrCreateEntry(projectUuid)
    entry.listeners.add(fn)
    if (entry.listeners.size === 1) {
      startSseConnection(projectUuid)
    }
    return () => {
      const current = sseStore.get(projectUuid)
      if (!current) return
      current.listeners.delete(fn)
      if (current.listeners.size === 0) {
        stopSseConnection(projectUuid)
        // Defer entry/cache deletion so React StrictMode's synchronous
        // unmount→remount cycle can re-subscribe before caches are cleared.
        // StrictMode runs cleanup + re-effect synchronously; setTimeout(0)
        // fires after that cycle. If a re-subscribe happened before the timeout
        // fires, listeners.size > 0 and cleanup is skipped — preventing the
        // new-function-ref → torn-read → re-render loop.
        // On real unmounts (no re-subscribe), listeners.size stays 0 and
        // entries are cleaned up, bounding memory growth per projectUuid.
        setTimeout(() => {
          const latest = sseStore.get(projectUuid)
          if (latest && latest.listeners.size === 0) {
            sseStore.delete(projectUuid)
            subscribeCache.delete(projectUuid)
            snapshotCache.delete(projectUuid)
          }
        }, 0)
      }
    }
  }
}

function getSseSnapshot(projectUuid: string): { latestEvents: Map<string, string>; errorState: boolean } {
  return sseStore.get(projectUuid)?.snapshot ?? EMPTY_STATE
}

// ---------------------------------------------------------------------------
// Stable per-projectUuid subscribe/snapshot refs for useSyncExternalStore.
// Cleaned up when the last listener unsubscribes (see subscribeSseStore).
// ---------------------------------------------------------------------------

const subscribeCache = new Map<string, (fn: () => void) => () => void>()
const snapshotCache = new Map<string, () => { latestEvents: Map<string, string>; errorState: boolean }>()

export function getSubscribe(projectUuid: string): (fn: () => void) => () => void {
  let fn = subscribeCache.get(projectUuid)
  if (!fn) {
    fn = subscribeSseStore(projectUuid)
    subscribeCache.set(projectUuid, fn)
  }
  return fn
}

export function getSnapshot(projectUuid: string): () => { latestEvents: Map<string, string>; errorState: boolean } {
  let fn = snapshotCache.get(projectUuid)
  if (!fn) {
    fn = () => getSseSnapshot(projectUuid)
    snapshotCache.set(projectUuid, fn)
  }
  return fn
}

// No-op subscribe/snapshot for when projectUuid is not yet available.
// Prevents opening a doomed SSE connection to an invalid projectId.
export const NO_OP_SUBSCRIBE = (_fn: () => void): (() => void) => () => {}
export const EMPTY_SNAPSHOT = (): { latestEvents: Map<string, string>; errorState: boolean } => EMPTY_STATE
