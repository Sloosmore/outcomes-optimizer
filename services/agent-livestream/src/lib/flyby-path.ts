type Point = { x: number; y: number }
type Rect = { x: number; y: number; w: number; h: number }

export type CubicSegment = { p0: Point; p1: Point; p2: Point; p3: Point }
export type FlybyPath = CubicSegment[]

// ─── Bezier math primitives ──────────────────────────────────────────────

function bezier(t: number, a: number, b: number, c: number, d: number): number {
  const mt = 1 - t
  return mt * mt * mt * a + 3 * mt * mt * t * b + 3 * mt * t * t * c + t * t * t * d
}

function bezierDeriv(t: number, a: number, b: number, c: number, d: number): number {
  const mt = 1 - t
  return 3 * mt * mt * (b - a) + 6 * mt * t * (c - b) + 3 * t * t * (d - c)
}

function evalSegment(t: number, seg: CubicSegment) {
  const x = bezier(t, seg.p0.x, seg.p1.x, seg.p2.x, seg.p3.x)
  const y = bezier(t, seg.p0.y, seg.p1.y, seg.p2.y, seg.p3.y)
  const dx = bezierDeriv(t, seg.p0.x, seg.p1.x, seg.p2.x, seg.p3.x)
  const dy = bezierDeriv(t, seg.p0.y, seg.p1.y, seg.p2.y, seg.p3.y)
  return { x, y, angleDeg: Math.atan2(dy, dx) * (180 / Math.PI) }
}

/** Evaluate a multi-segment path at global t in [0, 1]. */
export function evalPath(t: number, path: FlybyPath): { x: number; y: number; angleDeg: number } {
  const n = path.length
  const scaled = Math.max(0, Math.min(t * n, n - 0.0001))
  const segIdx = Math.floor(scaled)
  return evalSegment(scaled - segIdx, path[segIdx])
}

// ─── Shared path-generation utilities ────────────────────────────────────

const CANDIDATE_ANGLES = 12
const TWO_PI = Math.PI * 2
export const K = 0.5522847498 // bezier quarter-circle constant

function nearestEdgePoint(rect: Rect, p: Point): Point {
  return {
    x: Math.max(rect.x, Math.min(p.x, rect.x + rect.w)),
    y: Math.max(rect.y, Math.min(p.y, rect.y + rect.h)),
  }
}

export function edgePointAtAngle(center: Point, halfW: number, halfH: number, angle: number): Point {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const tx = cos !== 0 ? halfW / Math.abs(cos) : Infinity
  const ty = sin !== 0 ? halfH / Math.abs(sin) : Infinity
  const t = Math.min(tx, ty)
  return { x: center.x + cos * t, y: center.y + sin * t }
}

function seg(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): CubicSegment {
  return { p0: { x: x0, y: y0 }, p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, p3: { x: x3, y: y3 } }
}

/**
 * Find the outbound angle with the most clearance from neighbor cards.
 * Checks three key loop waypoints — bigRt, cross (tip), bigLt — so paths
 * can't cut through a card even if the direct probe point clears it.
 * nearestEdgePoint returns the probe itself when inside a rect → distance=0,
 * so any overlapping direction scores 0 and loses to open space.
 */
function findBestAngle(
  cardCenter: Point, halfW: number, halfH: number,
  bigR: number, staggerIndex: number, neighborRects: Rect[],
): number {
  let bestAngle = 0
  let bestScore = -Infinity

  for (let i = 0; i < CANDIDATE_ANGLES; i++) {
    const angle = (i / CANDIDATE_ANGLES) * TWO_PI
    const edge = edgePointAtAngle(cardCenter, halfW, halfH, angle)
    const cos = Math.cos(angle), sin = Math.sin(angle)
    const rtx = Math.cos(angle - Math.PI / 2), rty = Math.sin(angle - Math.PI / 2)
    const bigCx = edge.x + cos * bigR, bigCy = edge.y + sin * bigR

    const probes = [
      { x: bigCx + rtx * bigR, y: bigCy + rty * bigR },           // bigRt
      { x: edge.x + cos * bigR * 2, y: edge.y + sin * bigR * 2 }, // cross/tip
      { x: bigCx - rtx * bigR, y: bigCy - rty * bigR },           // bigLt
    ]

    let minDist = Infinity
    for (const p of probes) {
      for (const rect of neighborRects) {
        const nearest = nearestEdgePoint(rect, p)
        const dx = p.x - nearest.x, dy = p.y - nearest.y
        minDist = Math.min(minDist, Math.sqrt(dx * dx + dy * dy))
      }
    }

    const upBonus = -Math.sin(angle) * 20
    if (minDist + upBonus > bestScore) {
      bestScore = minDist + upBonus
      bestAngle = angle
    }
  }

  return bestAngle + staggerIndex * (Math.PI / 6)
}

// ─── Figure-eight (8 segments, holdAt t=0.25) ────────────────────────────

/**
 * card → crossing (big loop) → small loop turnaround → crossing → card (big loop).
 * Hold point is the crossing at t=0.25.
 */
export function computeFlybyCurve(
  cardCenter: Point,
  cardSize: { w: number; h: number },
  neighborRects: Rect[],
  staggerIndex: number,
  bigR = 70,
  smR = 35,
): FlybyPath {
  const halfW = cardSize.w / 2, halfH = cardSize.h / 2
  const a = findBestAngle(cardCenter, halfW, halfH, bigR, staggerIndex, neighborRects)

  const fwd = { x: Math.cos(a), y: Math.sin(a) }
  const rt = { x: Math.cos(a - Math.PI / 2), y: Math.sin(a - Math.PI / 2) }
  const lt = { x: -rt.x, y: -rt.y }
  const bk = { x: -fwd.x, y: -fwd.y }

  const start = edgePointAtAngle(cardCenter, halfW, halfH, a)
  const ox = start.x - cardCenter.x, oy = start.y - cardCenter.y

  const bigC = { x: ox + fwd.x * bigR, y: oy + fwd.y * bigR }
  const cross = { x: ox + fwd.x * bigR * 2, y: oy + fwd.y * bigR * 2 }
  // Small loop is elliptical: elongated forward (smR_long) and narrow laterally (smR_short).
  // A circular small loop causes the cursor to rotate 360° while barely translating —
  // "carnival wheel" effect. The ellipse keeps translation dominant over rotation.
  const smR_long = smR
  const smR_short = smR * 0.65

  // Small loop orbits around the crossing point itself (not beyond it).
  // The old placement (smC = cross + fwd*smR_long) put smTop at cross + 2×smR —
  // the same reach as the big loop — landing on top of neighboring cards.
  const smC = cross
  const smTop = { x: smC.x + fwd.x * smR_long, y: smC.y + fwd.y * smR_long }
  const bigRt = { x: bigC.x + rt.x * bigR, y: bigC.y + rt.y * bigR }
  const bigLt = { x: bigC.x + lt.x * bigR, y: bigC.y + lt.y * bigR }
  const smLt = { x: smC.x + lt.x * smR_short, y: smC.y + lt.y * smR_short }
  const smRt = { x: smC.x + rt.x * smR_short, y: smC.y + rt.y * smR_short }

  const q1a = seg(ox, oy, ox+rt.x*bigR*K, oy+rt.y*bigR*K, bigRt.x+bk.x*bigR*K, bigRt.y+bk.y*bigR*K, bigRt.x, bigRt.y)
  const q1b = seg(bigRt.x, bigRt.y, bigRt.x+fwd.x*bigR*K, bigRt.y+fwd.y*bigR*K, cross.x+rt.x*bigR*K, cross.y+rt.y*bigR*K, cross.x, cross.y)
  // Differential bezier handles: smR_long for fwd/bk transitions, smR_short for lt/rt transitions
  const q2a = seg(cross.x, cross.y, cross.x+lt.x*smR_short*K, cross.y+lt.y*smR_short*K, smLt.x+bk.x*smR_long*K, smLt.y+bk.y*smR_long*K, smLt.x, smLt.y)
  const q2b = seg(smLt.x, smLt.y, smLt.x+fwd.x*smR_long*K, smLt.y+fwd.y*smR_long*K, smTop.x+lt.x*smR_short*K, smTop.y+lt.y*smR_short*K, smTop.x, smTop.y)
  const q3a = seg(smTop.x, smTop.y, smTop.x+rt.x*smR_short*K, smTop.y+rt.y*smR_short*K, smRt.x+fwd.x*smR_long*K, smRt.y+fwd.y*smR_long*K, smRt.x, smRt.y)
  const q3b = seg(smRt.x, smRt.y, smRt.x+bk.x*smR_long*K, smRt.y+bk.y*smR_long*K, cross.x+rt.x*smR_short*K, cross.y+rt.y*smR_short*K, cross.x, cross.y)
  const q4a = seg(cross.x, cross.y, cross.x+lt.x*bigR*K, cross.y+lt.y*bigR*K, bigLt.x+fwd.x*bigR*K, bigLt.y+fwd.y*bigR*K, bigLt.x, bigLt.y)
  const q4b = seg(bigLt.x, bigLt.y, bigLt.x+bk.x*bigR*K, bigLt.y+bk.y*bigR*K, ox+lt.x*bigR*K, oy+lt.y*bigR*K, ox, oy)

  return [q1a, q1b, q2a, q2b, q3a, q3b, q4a, q4b]
}

// ─── Loop (4 segments, holdAt t=0.5) ─────────────────────────────────────

/**
 * card → bigRt → cross (tip) → bigLt → card.
 * A single smooth circle. Hold point is the tip at t=0.5.
 */
export function computeLoopCurve(
  cardCenter: Point,
  cardSize: { w: number; h: number },
  neighborRects: Rect[],
  staggerIndex: number,
  bigR = 70,
): FlybyPath {
  const halfW = cardSize.w / 2, halfH = cardSize.h / 2
  const a = findBestAngle(cardCenter, halfW, halfH, bigR, staggerIndex, neighborRects)

  const fwd = { x: Math.cos(a), y: Math.sin(a) }
  const rt = { x: Math.cos(a - Math.PI / 2), y: Math.sin(a - Math.PI / 2) }
  const lt = { x: -rt.x, y: -rt.y }
  const bk = { x: -fwd.x, y: -fwd.y }

  const start = edgePointAtAngle(cardCenter, halfW, halfH, a)
  const ox = start.x - cardCenter.x, oy = start.y - cardCenter.y

  const bigC = { x: ox + fwd.x * bigR, y: oy + fwd.y * bigR }
  const cross = { x: ox + fwd.x * bigR * 2, y: oy + fwd.y * bigR * 2 }
  const bigRt = { x: bigC.x + rt.x * bigR, y: bigC.y + rt.y * bigR }
  const bigLt = { x: bigC.x + lt.x * bigR, y: bigC.y + lt.y * bigR }

  const s1 = seg(ox, oy, ox+rt.x*bigR*K, oy+rt.y*bigR*K, bigRt.x+bk.x*bigR*K, bigRt.y+bk.y*bigR*K, bigRt.x, bigRt.y)
  const s2 = seg(bigRt.x, bigRt.y, bigRt.x+fwd.x*bigR*K, bigRt.y+fwd.y*bigR*K, cross.x+rt.x*bigR*K, cross.y+rt.y*bigR*K, cross.x, cross.y)
  const s3 = seg(cross.x, cross.y, cross.x+lt.x*bigR*K, cross.y+lt.y*bigR*K, bigLt.x+fwd.x*bigR*K, bigLt.y+fwd.y*bigR*K, bigLt.x, bigLt.y)
  const s4 = seg(bigLt.x, bigLt.y, bigLt.x+bk.x*bigR*K, bigLt.y+bk.y*bigR*K, ox+lt.x*bigR*K, oy+lt.y*bigR*K, ox, oy)

  return [s1, s2, s3, s4]
}
