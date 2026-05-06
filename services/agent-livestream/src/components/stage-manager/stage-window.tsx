import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import type { Slot } from './slot-math'
import { THUMB_NATURAL_WIDTH_PX, THUMB_NATURAL_HEIGHT_PX } from './slot-math'

interface StageWindowProps {
  url: string
  slot: Slot
  onActivate: () => void
}

/**
 * One artifact tile. The iframe is mounted exactly once when the component
 * first renders for a given `url`; thereafter the tile animates between slots
 * by transforming its container only — never re-parenting the iframe.
 *
 * Reload-on-swap is the bug we are guarding against. If you ever see iframes
 * reload when the active tile changes, drop animation libraries entirely and
 * stick with the pure CSS transform approach used here.
 *
 * `style` is the documented exception for runtime CSS positioning that cannot
 * be expressed in Tailwind utility classes (per CLAUDE.md).
 */
export function StageWindow({ url, slot, onActivate }: StageWindowProps) {
  const lastLoggedUrl = useRef<string | null>(null)
  useEffect(() => {
    if (url !== lastLoggedUrl.current) {
      lastLoggedUrl.current = url
      // eslint-disable-next-line no-console -- Browser bundle has no structured logger; instrumentation only.
      console.info('[agent-livestream:stage-window] phase', {
        phase: 'iframe_mounted',
        t_ms: typeof performance !== 'undefined' ? performance.now() : Date.now(),
        url,
      })
    }
  }, [url])

  // Measure rendered tile width so we can compute the iframe scale factor for
  // inactive (rail) tiles. The iframe lays out at THUMB_NATURAL_WIDTH_PX wide;
  // we visually shrink it so the inner HTML keeps its real layout instead of
  // reflowing into the tiny rail box. ResizeObserver re-fires on swap so the
  // scale stays correct as the active tile changes.
  // Measure rendered tile size and scale the iframe so its 1280×720 natural
  // layout fills the wrapper proportionally — both for rail thumbnails (scale
  // < 1) and for the active tile when the wrapper is larger (scale > 1).
  // ResizeObserver re-fires on swap so the scale stays correct.
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [iframeScale, setIframeScale] = useState(1)
  useLayoutEffect(() => {
    if (slot.isActive) return
    const el = wrapperRef.current
    if (!el) return
    const measure = () => {
      const sx = el.clientWidth / THUMB_NATURAL_WIDTH_PX
      const sy = el.clientHeight / THUMB_NATURAL_HEIGHT_PX
      setIframeScale(Math.min(sx, sy))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [slot.isActive])

  // Inactive (rail) tiles get a subtle Y-axis tilt so they recede toward the
  // center, matching the iPad Stage Manager aesthetic. Active tile sits flat.
  const style: CSSProperties = {
    left: slot.left,
    top: slot.top,
    width: slot.width,
    height: slot.height,
    transform: slot.isActive
      ? undefined
      : 'perspective(2000px) rotateY(35deg) scale(0.9)',
    transformOrigin: 'left center',
  }

  return (
    <div
      ref={wrapperRef}
      data-testid="stage-window"
      data-active={slot.isActive ? 'true' : 'false'}
      style={style}
      className={cn(
        'absolute overflow-hidden rounded-xl shadow-2xl',
        'transition-all duration-300 ease-out',
      )}
    >
      {/*
        One iframe element, always laid out at the natural 1280×720 size and
        visually scaled to fit the wrapper. Same DOM node across stage-mode
        toggles + tile swaps — no reload, no reflow. Inner HTML renders at
        its real layout (dashboards, charts) instead of squishing into the box.
      */}
      <iframe
        data-testid="artifact-frame"
        src={url}
        // Active tile: responsive `h-full w-full` so the artifact's HTML
        // fills the wrapper (top-to-bottom of the panel). Rail tile: natural
        // 1280×720 with CSS scale so the inner layout stays readable in the
        // tiny rail box.
        className={slot.isActive ? 'h-full w-full border-0' : 'origin-top-left border-0'}
        style={slot.isActive ? undefined : {
          width: `${THUMB_NATURAL_WIDTH_PX}px`,
          height: `${THUMB_NATURAL_HEIGHT_PX}px`,
          transform: `scale(${iframeScale})`,
        }}
        title="Research artifact"
        sandbox="allow-scripts allow-same-origin allow-forms"
      />
      {/*
        Click shield for inactive tiles. An iframe with cross-origin content
        will swallow click events — without this overlay the rail tiles would
        be uninteractable. On the active tile we let clicks fall through.
      */}
      {!slot.isActive && (
        <button
          type="button"
          aria-label="Activate this tile"
          onClick={onActivate}
          className="absolute inset-0 cursor-pointer bg-transparent hover:bg-foreground/5"
        />
      )}
    </div>
  )
}
