import { useCallback, useEffect, useRef, useState } from 'react'
import {
  TERRAIN_FOLLOW_INTERVAL_MS,
  TERRAIN_FOLLOW_EASE_DURATION_MS,
  TERRAIN_FOLLOW_ZOOM,
  TERRAIN_FOLLOW_INITIAL_ZOOM_DURATION_MS,
} from '@/constants'

/** Parse `translate(Xpx, Ypx)` from a DOM element's inline transform. */
function parseTranslate(el: HTMLElement): { x: number; y: number } | null {
  const t = el.style.transform
  const match = t.match(/translate\(\s*([-\d.]+)px,\s*([-\d.]+)px\s*\)/)
  if (!match) return null
  return { x: parseFloat(match[1]), y: parseFloat(match[2]) }
}

/**
 * State management for camera-follow (works outside ReactFlow context).
 *
 * isProgrammaticMove prevents onMoveStart from killing follow
 * when our own setCenter() triggers the viewport move event.
 */
export function useCursorFollowState() {
  const [followedId, setFollowedId] = useState<string | null>(null)
  const cursorRefsMap = useRef<Map<string, HTMLDivElement>>(new Map())
  const isProgrammaticMove = useRef(false)

  const registerCursorRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) {
      cursorRefsMap.current.set(id, el)
    } else {
      cursorRefsMap.current.delete(id)
    }
  }, [])

  const startFollowing = useCallback((id: string) => {
    setFollowedId(id)
  }, [])

  const stopFollowing = useCallback(() => {
    setFollowedId(null)
  }, [])

  /** Call from onMoveStart — only stops follow if user initiated the move */
  const onViewportMoveStart = useCallback(() => {
    if (isProgrammaticMove.current) return
    setFollowedId(null)
  }, [])

  return { followedId, startFollowing, stopFollowing, registerCursorRef, cursorRefsMap, isProgrammaticMove, onViewportMoveStart }
}

/**
 * Camera tracking effect — must be called from inside <ReactFlow>.
 */
export function useCursorFollowCamera(
  followedId: string | null,
  cursorRefsMap: React.RefObject<Map<string, HTMLDivElement>>,
  setCenter: (x: number, y: number, opts: { zoom: number; duration: number }) => void,
  isProgrammaticMove: React.MutableRefObject<boolean>,
) {
  useEffect(() => {
    if (!followedId) return

    // Single ref for the "unlock" timeout — cleared and reset each interval tick
    let unlockTimeout: ReturnType<typeof setTimeout> | null = null

    const unlockAfter = (ms: number) => {
      if (unlockTimeout !== null) clearTimeout(unlockTimeout)
      unlockTimeout = setTimeout(() => { isProgrammaticMove.current = false }, ms)
    }

    // Initial zoom to cursor's current position
    const el = cursorRefsMap.current?.get(followedId)
    if (el) {
      const pos = parseTranslate(el)
      if (pos) {
        isProgrammaticMove.current = true
        setCenter(pos.x, pos.y, { zoom: TERRAIN_FOLLOW_ZOOM, duration: TERRAIN_FOLLOW_INITIAL_ZOOM_DURATION_MS })
        unlockAfter(TERRAIN_FOLLOW_INITIAL_ZOOM_DURATION_MS + 100)
      }
    }

    // Track cursor position
    const intervalId = setInterval(() => {
      const cursor = cursorRefsMap.current?.get(followedId)
      if (!cursor) return
      const pos = parseTranslate(cursor)
      if (!pos) return
      isProgrammaticMove.current = true
      setCenter(pos.x, pos.y, { zoom: TERRAIN_FOLLOW_ZOOM, duration: TERRAIN_FOLLOW_EASE_DURATION_MS })
      unlockAfter(TERRAIN_FOLLOW_EASE_DURATION_MS + 50)
    }, TERRAIN_FOLLOW_INTERVAL_MS)

    return () => {
      clearInterval(intervalId)
      if (unlockTimeout !== null) clearTimeout(unlockTimeout)
    }
    // cursorRefsMap, setCenter, isProgrammaticMove are stable refs; followedId drives the interval
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followedId])
}
