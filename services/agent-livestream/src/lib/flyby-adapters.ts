import type { FlybyPath } from './flyby-path'
import { computeFlybyCurve, computeLoopCurve } from './flyby-path'
import { FLYBY_DISPLAY_MS } from '@/constants'

type Point = { x: number; y: number }
type Rect = { x: number; y: number; w: number; h: number }

export type PathParams = {
  cardCenter: Point
  cardSize: { w: number; h: number }
  neighborRects: Rect[]
  stagger: number
  bigR: number
  smR: number
}

export type PathAdapter = {
  id: string
  /** t ∈ [0,1] where the cursor pauses to show the badge */
  holdAt: number
  flyOutMs: number
  holdMs: number
  returnMs: number
  /** Cubic bezier easing for the return phase — varies by path shape */
  returnEase: [number, number, number, number]
  compute: (params: PathParams) => FlybyPath
}

/**
 * Figure-eight: big loop outbound → crossing hold → small loop turnaround → return.
 * The asymmetry (two different loop sizes) makes motion feel organic.
 */
const figureEightAdapter: PathAdapter = {
  id: 'figure-eight',
  holdAt: 0.25,
  flyOutMs: FLYBY_DISPLAY_MS * 0.15,
  holdMs: FLYBY_DISPLAY_MS * 0.50,
  returnMs: FLYBY_DISPLAY_MS * 0.35,
  // easeInOut: starts slow so the elliptical small loop is visible before accelerating home
  returnEase: [0.2, 0, 0.8, 1],
  compute: ({ cardCenter, cardSize, neighborRects, stagger, bigR, smR }) =>
    computeFlybyCurve(cardCenter, cardSize, neighborRects, stagger, bigR, smR),
}

/**
 * Loop: single smooth circle — fly to the tip, hold, arc back.
 * Simpler than figure-eight; useful as a contrast motion style.
 */
const loopAdapter: PathAdapter = {
  id: 'loop',
  holdAt: 0.5,
  flyOutMs: FLYBY_DISPLAY_MS * 0.20,
  holdMs: FLYBY_DISPLAY_MS * 0.40,
  returnMs: FLYBY_DISPLAY_MS * 0.40,
  // easeOut: starts immediately (no small loop to pace) and decelerates as it approaches the card
  returnEase: [0, 0, 0.3, 1],
  compute: ({ cardCenter, cardSize, neighborRects, stagger, bigR }) =>
    computeLoopCurve(cardCenter, cardSize, neighborRects, stagger, bigR),
}

const ADAPTERS: PathAdapter[] = [figureEightAdapter, loopAdapter]

/**
 * Pick an adapter deterministically from the event's stagger hash (0–11).
 * Different events on the same card use the same adapter for their stagger
 * slot, giving consistent motion variety without per-render randomness.
 */
export function selectAdapter(stagger: number): PathAdapter {
  return ADAPTERS[stagger % ADAPTERS.length]
}
