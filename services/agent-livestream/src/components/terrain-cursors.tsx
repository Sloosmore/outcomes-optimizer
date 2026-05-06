import { useMemo, useState, useRef, useEffect } from 'react'
import { ViewportPortal, useStore } from '@xyflow/react'
import type { CursorList } from '@/hooks/use-cursor-nodes'
import { MousePointer2 } from 'lucide-react'
import { selectZoom } from '@/lib/graph-constants'
import { usePolledLatestEvents } from '@/hooks/use-polled-latest-events'
import { useCursorAnimation } from '@/hooks/use-cursor-animation'
import { layoutCursors, type CursorData } from '@/lib/cursor-layout'
import { TERRAIN_BADGE_ZOOM_THRESHOLD } from '@/constants'
import { AskUserPanel, type AskUserQuestion } from '@/components/ask-user-panel'
const TRUNCATE_LEN = 12

/**
 * Demo / screenshot toggle for the upcoming `ask_user` tool UI. Passing
 * `?askUser=<process_id>` (comma-separated or repeated for multiple cursors)
 * replaces the small terrain-cursor pill with a question card.
 *
 * Question shape — including whether each prompt is a single-choice or a
 * multi-choice — is per-question and per-cursor: the agent decides what to
 * ask, and a single ask_user call may include questions of either kind. To
 * demonstrate that, we cycle through the demo sets below in URL order, so
 * the first cursor in `?askUser=pid1,pid2` shows a different kind than the
 * second. Real per-event questions arrive in the event payload when this
 * gets wired to `agent_events`.
 */
const DEMO_QUESTION_SETS: AskUserQuestion[][] = [
  // Set A — single-choice only.
  [
    {
      kind: 'select_one',
      text: 'Which fix should I apply for the failing migration?',
      options: [
        'Roll forward with the corrected schema',
        'Roll back to the previous migration',
        'Pause and wait for human review',
      ],
    },
  ],
  // Set B — multi-choice only.
  [
    {
      kind: 'select_multiple',
      text: 'Which non-regression checks should I run before continuing?',
      options: [
        'Unit tests',
        'RPC matrix integration tests',
        'Schema-drift check',
        'Frontend type-check',
      ],
    },
  ],
]

function readAskUserOverride(): Map<string, AskUserQuestion[]> | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const raw = params.getAll('askUser')
  if (raw.length === 0) return null
  // Preserve URL order so the first id gets the first demo set, second gets
  // the second, etc. Wraps if the operator passes more ids than demo sets.
  const ordered = raw.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)
  if (ordered.length === 0) return null
  const map = new Map<string, AskUserQuestion[]>()
  ordered.forEach((pid, idx) => {
    map.set(pid, DEMO_QUESTION_SETS[idx % DEMO_QUESTION_SETS.length]!)
  })
  return map
}

/** Per-cursor sub-component — owns its own rAF animation loop. */
function AnimatedCursor({
  cursor,
  showBadge,
  latestEvents,
  isFollowed,
  onFollow,
  registerRef,
  askUserQuestions,
}: {
  cursor: CursorData
  showBadge: boolean
  latestEvents: Map<string, string>
  isFollowed: boolean
  onFollow?: (id: string) => void
  registerRef?: (id: string, el: HTMLDivElement | null) => void
  /** When set, the small badge is replaced with a multi-question ask_user card. */
  askUserQuestions?: AskUserQuestion[]
}) {
  const posRef = useRef<HTMLDivElement>(null)

  // Register ref with parent for camera follow
  useEffect(() => {
    const el = posRef.current
    registerRef?.(cursor.id, el)
    return () => { registerRef?.(cursor.id, null) }
  }, [cursor.id, registerRef])
  const rotRef = useRef<HTMLDivElement>(null)
  const [isHovered, setIsHovered] = useState(false)
  const applyPush = useCursorAnimation(cursor.x, cursor.y, cursor.id, posRef, rotRef)

  // Push cursor on new tool call event
  const lastEventRef = useRef<string | null>(cursor.lastTool)
  useEffect(() => {
    const newEvent = latestEvents.get(cursor.id)
    if (newEvent && newEvent !== lastEventRef.current) {
      lastEventRef.current = newEvent
      applyPush(newEvent)
    }
  }, [latestEvents, cursor.id, applyPush])

  const rawTool = latestEvents.get(cursor.id) ?? cursor.lastTool
  // Strip encoded token count suffix (e.g. "token_usage:1234" → "token_usage")
  const colonIdx = rawTool?.indexOf(':') ?? -1
  const currentTool = colonIdx > 0 && !Number.isNaN(Number(rawTool!.slice(colonIdx + 1)))
    ? rawTool!.slice(0, colonIdx)
    : rawTool
  const shortLabel = currentTool
    ? (currentTool.length > TRUNCATE_LEN ? currentTool.slice(0, TRUNCATE_LEN) + '…' : currentTool)
    : (cursor.name.length > TRUNCATE_LEN ? cursor.name.slice(0, TRUNCATE_LEN) + '…' : cursor.name)
  const badgeText = isHovered ? cursor.name : shortLabel

  return (
    <div
      ref={posRef}
      role="button"
      tabIndex={0}
      aria-label={`Follow agent ${cursor.name}`}
      className="absolute pointer-events-auto cursor-pointer"
      /* tokens-ok: initial position set here, rAF loop updates transform directly */
      style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` } as React.CSSProperties}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={() => onFollow?.(cursor.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onFollow?.(cursor.id) }}
    >
      {isFollowed && (
        <div className="absolute -inset-2 rounded-full border-2 border-ring animate-pulse opacity-60" />
      )}
      <div className="flex items-start gap-1">
        {/* Rotation wrapper — only rotates the cursor SVG */}
        <div ref={rotRef} className={`pointer-events-none shrink-0 ${cursor.color.fill}`}>
          <MousePointer2
            className="h-7 w-7 fill-current drop-shadow-md"
            stroke="white"
            strokeWidth={2.5}
            strokeLinejoin="round"
          />
        </div>
        {/* Badge moves with cursor, stays upright. When ask_user is active for
            this cursor we replace the small pill with a multi-question card.
            The card shows regardless of zoom because it represents an
            actionable user prompt — losing it on zoom-out would hide work. */}
        {askUserQuestions && askUserQuestions.length > 0 ? (
          <AskUserPanel
            processName={cursor.name}
            questions={askUserQuestions}
            badgeBgClass={cursor.color.bg}
            className="mt-1"
          />
        ) : (
          showBadge && badgeText && (
            <div
              className={`rounded-full border-0 px-2.5 py-0.5 text-2xs text-white whitespace-nowrap shadow-md ${cursor.color.bg}`}
            >
              {badgeText}
            </div>
          )
        )}
      </div>
    </div>
  )
}

interface TerrainCursorsProps {
  cursorMap: Map<string, CursorList>
  terrainPositions: Map<string, { x: number; y: number }>
  followedId?: string | null
  onFollow?: (id: string) => void
  registerRef?: (id: string, el: HTMLDivElement | null) => void
}

export function TerrainCursors({ cursorMap, terrainPositions, followedId, onFollow, registerRef }: TerrainCursorsProps) {
  const zoom = useStore(selectZoom)
  const showBadge = zoom >= TERRAIN_BADGE_ZOOM_THRESHOLD
  const latestEvents = usePolledLatestEvents(cursorMap)

  const cursors = useMemo(
    () => layoutCursors(cursorMap, terrainPositions, latestEvents),
    [cursorMap, terrainPositions, latestEvents],
  )

  // URL-param toggle for the ask_user panel. Read once per render — the
  // override targets specific process_ids and the URL changes only on
  // navigation (which remounts this component anyway).
  const askUserOverride = useMemo(() => readAskUserOverride(), [])

  if (cursors.length === 0) return null

  return (
    <ViewportPortal>
      <div className="absolute top-0 left-0">
        {cursors.map((c) => (
          <AnimatedCursor
            key={c.id}
            cursor={c}
            showBadge={showBadge}
            latestEvents={latestEvents}
            isFollowed={followedId === c.id}
            onFollow={onFollow}
            registerRef={registerRef}
            askUserQuestions={askUserOverride?.get(c.id)}
          />
        ))}
      </div>
    </ViewportPortal>
  )
}
