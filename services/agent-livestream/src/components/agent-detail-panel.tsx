import { useRef, useMemo, useEffect, useLayoutEffect, useCallback, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowDown } from 'lucide-react'
import type { ActiveProcess } from '@/hooks/use-cursor-nodes'
import type { ApiProcessEventsResponse } from '@skill-networks/contracts/processes'
import { Skeleton } from '@/components/ui/skeleton'
import { apiFetch } from '@/lib/api-fetch'
import { EVENTS_PAGE_SIZE, EVENTS_NEAR_BOTTOM_PX, EVENTS_POLL_INTERVAL_MS } from '@/constants'

/** Deterministic pseudo-random skeleton widths: [source, payload | null, timestamp] */
const SKELETON_WIDTHS: [string, string | null, string][] = [
  ['w-24', 'w-52', 'w-14'],
  ['w-36', null, 'w-12'],
  ['w-28', 'w-40', 'w-16'],
  ['w-32', 'w-56', 'w-14'],
  ['w-20', 'w-44', 'w-12'],
  ['w-40', null, 'w-16'],
  ['w-28', 'w-36', 'w-14'],
  ['w-36', 'w-48', 'w-12'],
  ['w-24', null, 'w-16'],
  ['w-32', 'w-52', 'w-14'],
]

function isNearBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < EVENTS_NEAR_BOTTOM_PX
}

async function fetchEvents(processId: string, params: Record<string, string> = {}): Promise<ApiProcessEventsResponse> {
  const search = new URLSearchParams({ limit: String(EVENTS_PAGE_SIZE), ...params })
  const r = await apiFetch(`/api/process-events/${processId}?${search}`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export function AgentDetailPanel({ process }: { process: ActiveProcess }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const hasScrolledRef = useRef(false)
  const prevHeightRef = useRef(0)
  const [showArrow, setShowArrow] = useState(false)

  // Reset scroll state when switching processes
  useEffect(() => {
    hasScrolledRef.current = false
    prevHeightRef.current = 0
  }, [process.process_id])

  // Backwards-paginated history (initial load = latest page, scroll up = older pages)
  const {
    data: historyData,
    fetchPreviousPage,
    hasPreviousPage,
    isFetchingPreviousPage,
    isPending,
  } = useInfiniteQuery({
    queryKey: ['process-events-history', process.process_id],
    queryFn: ({ pageParam }) => fetchEvents(process.process_id, pageParam),
    initialPageParam: {} as Record<string, string>,
    getPreviousPageParam: (firstPage) =>
      firstPage.events.length === EVENTS_PAGE_SIZE ? { before: firstPage.events[0].ts } : undefined,
    getNextPageParam: () => undefined,
  })

  // The newest timestamp from history — used as cursor for tail polling
  // Tail events are re-fetched on each poll using the same cursor; client dedup handles duplicates
  const newestTs = useMemo(() => {
    const pages = historyData?.pages ?? []
    const lastPage = pages[pages.length - 1]
    return lastPage?.events[lastPage.events.length - 1]?.ts
  }, [historyData])

  // Live tail: poll for events after the newest timestamp
  const { data: tailData } = useQuery<ApiProcessEventsResponse>({
    queryKey: ['process-events-tail', process.process_id, newestTs],
    queryFn: () => newestTs ? fetchEvents(process.process_id, { after: newestTs }) : Promise.resolve({ events: [], total: 0 }),
    refetchInterval: EVENTS_POLL_INTERVAL_MS,
    enabled: !!newestTs,
  })
  const tailEvents = tailData?.events ?? []

  // Merge: all history pages + tail events, deduplicated by id
  const events = useMemo(() => {
    const historyEvents = historyData?.pages.flatMap((p) => p.events) ?? []
    const all = [...historyEvents, ...tailEvents]
    const seen = new Set<string>()
    return all.filter((e) => { if (seen.has(e.id)) return false; seen.add(e.id); return true })
  }, [historyData, tailEvents])

  // Spacer disabled — the hardcoded estimate caused scrollbar height to shrink as real
  // rows (shorter than estimated) replaced the spacer. Better to show an honest scrollbar
  // that reflects loaded content only.
  const spacerHeight = 0

  // First load: jump to bottom before paint
  useLayoutEffect(() => {
    if (!scrollRef.current || events.length === 0 || hasScrolledRef.current) return
    scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'instant' })
    hasScrolledRef.current = true
    prevHeightRef.current = scrollRef.current.scrollHeight
  }, [events.length])

  // After prepending older pages: preserve scroll position
  useLayoutEffect(() => {
    if (!scrollRef.current || !hasScrolledRef.current) return
    const newHeight = scrollRef.current.scrollHeight
    const delta = newHeight - prevHeightRef.current
    if (delta > 0 && scrollRef.current.scrollTop < EVENTS_NEAR_BOTTOM_PX * 2) {
      scrollRef.current.scrollTop += delta
    }
    prevHeightRef.current = newHeight
  }, [events])

  // New tail events: smooth scroll if near bottom
  useEffect(() => {
    if (!scrollRef.current || !hasScrolledRef.current) return
    if (isNearBottom(scrollRef.current)) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [tailEvents.length])

  // Intersection observer: load older events when sentinel is visible
  useEffect(() => {
    const sentinel = sentinelRef.current
    const container = scrollRef.current
    if (!sentinel || !container) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && hasPreviousPage && !isFetchingPreviousPage) {
          void fetchPreviousPage()
        }
      },
      { root: container, rootMargin: '1200px 0px 0px 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasPreviousPage, isFetchingPreviousPage, fetchPreviousPage])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    setShowArrow(!isNearBottom(scrollRef.current))
  }, [])

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [])

  return (
    <div className="flex flex-col h-full relative">
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
        {isPending ? (
          <div className="flex flex-col justify-end h-full" role="status" aria-label="Loading events">
            {SKELETON_WIDTHS.map((widths, i) => (
              <div key={i} className="px-4 py-2.5 border-b last:border-b-0 flex flex-col gap-1.5">
                <Skeleton className={`h-3 ${widths[0]}`} />
                {widths[1] && <Skeleton className={`h-3 ${widths[1]}`} />}
                <Skeleton className={`h-2.5 ${widths[2]}`} />
              </div>
            ))}
          </div>
        ) : events.length === 0 ? (
          <p className="px-4 py-8 text-xs text-muted-foreground/60 text-center">No events yet</p>
        ) : (
          <div className="flex flex-col">
            {/* Spacer represents unloaded events above — stabilizes scrollbar */}
            {/* tokens-ok: runtime-computed height with no static Tailwind equivalent */}
            {spacerHeight > 0 && <div style={{ '--spacer-h': `${spacerHeight}px` } as React.CSSProperties} className="[height:var(--spacer-h)]" />}
            {/* Sentinel for loading older events */}
            <div ref={sentinelRef} className="h-px" />
            {isFetchingPreviousPage && (
              <p className="px-4 py-2 text-xs text-muted-foreground/50 text-center">Loading older events…</p>
            )}
            {events.map((event) => {
              const payloadText = event.payload?.text
              return (
                <div key={event.id} className="px-4 py-2.5 border-b last:border-b-0 flex flex-col gap-0.5">
                  <p className="text-xs font-mono break-all leading-relaxed text-foreground/80">
                    {event.source}
                  </p>
                  {payloadText != null && (
                    <p className="text-xs text-muted-foreground/70 break-all leading-relaxed mt-0.5">
                      {String(payloadText).slice(0, 300)}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground/50 tabular-nums">
                    {new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </p>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {showArrow && (
        <button
          type="button"
          aria-label="Scroll to bottom"
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 flex h-7 w-7 items-center justify-center rounded-full bg-muted/80 backdrop-blur-sm border border-border/40 text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
