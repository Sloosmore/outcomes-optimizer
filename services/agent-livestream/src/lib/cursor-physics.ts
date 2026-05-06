/**
 * Cursor physics with heading + angular inertia + per-cursor seeded RNG.
 *
 * Each cursor gets its own PRNG seeded from process ID so they
 * wander independently even when frames are synchronized.
 */

export interface CursorPhysicsState {
  x: number
  y: number
  heading: number
  angularVel: number
  speed: number
  homeX: number
  homeY: number
  rng: () => number  // per-cursor seeded PRNG
}

import { mulberry32, hashString } from '@/lib/seeded-rng'

export function initCursorPhysics(
  homeX: number,
  homeY: number,
  processId: string,
): CursorPhysicsState {
  const rng = mulberry32(hashString(processId))
  // Advance RNG a few times so initial state diverges between cursors
  for (let i = 0; i < 10; i++) rng()
  const heading = rng() * Math.PI * 2
  // Start at home, stationary — events are the sole energy source.
  // A small offset prevents cursors from stacking on the exact same pixel.
  const startDist = 5 + rng() * 10
  const startX = homeX + Math.cos(heading) * startDist
  const startY = homeY + Math.sin(heading) * startDist
  return { x: startX, y: startY, heading, angularVel: 0, speed: 0, homeX, homeY, rng }
}

export function stepPhysics(
  state: CursorPhysicsState,
  dt: number,
  config: PhysicsConfig,
  impulse?: number,
): CursorPhysicsState {
  let { x, y, heading, angularVel, speed } = state
  const { rng } = state
  const { homeX, homeY } = state

  const dx = x - homeX
  const dy = y - homeY
  const dist = Math.sqrt(dx * dx + dy * dy)

  // --- Angular physics ---

  // Seeded random torque — each cursor wanders differently
  angularVel += (rng() - 0.5) * 2 * config.torqueNoise * dt

  // Soft probabilistic pull toward home — probability of turning homeward
  // increases smoothly with distance. No hard wall; cursors can venture far
  // but become increasingly likely to curve back.
  if (dist > config.homeDeadzone) {
    const angleToHome = Math.atan2(-dy, -dx)
    let angleDiff = angleToHome - heading
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2
    // t rises from 0 at homeDeadzone to 1 at softRadius, continues above 1 beyond
    // Guard against misconfigured range (softRadius <= homeDeadzone) by clamping denominator to 1
    const range = Math.max(1, config.softRadius - config.homeDeadzone)
    const t = (dist - config.homeDeadzone) / range
    // Quadratic ramp — gentle at first, escalates dramatically farther out
    const pullStrength = config.homeTorque * t * t
    angularVel += angleDiff * pullStrength * dt
  }

  // Angular damping (inertia)
  angularVel *= 1 - config.angularDamping * dt
  angularVel = Math.max(-config.maxAngularVel, Math.min(config.maxAngularVel, angularVel))

  heading += angularVel * dt
  heading = ((heading % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)

  // --- Linear physics ---

  let targetSpeed = config.baseSpeed

  if (impulse) {
    targetSpeed += impulse
  }

  speed += (targetSpeed - speed) * config.speedSmoothing * dt

  x += Math.cos(heading) * speed * dt
  y += Math.sin(heading) * speed * dt

  const newDist = Math.sqrt((x - homeX) ** 2 + (y - homeY) ** 2)

  // Gentle steer away from inner radius — apply outward torque, don't hard clamp
  if (newDist < config.minRadius && newDist > 0) {
    const angleFromHome = Math.atan2(y - homeY, x - homeX)
    // Nudge heading to point outward
    let angleDiff = angleFromHome - heading
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2
    // Stronger push the closer to center
    const urgency = 1 - (newDist / config.minRadius)
    angularVel += angleDiff * urgency * 3 * dt
    // Small speed boost to escape
    speed += urgency * 5 * dt
  }

  return { x, y, heading, angularVel, speed, homeX, homeY, rng }
}

export interface PhysicsConfig {
  baseSpeed: number
  torqueNoise: number
  homeTorque: number
  homeDeadzone: number
  angularDamping: number
  maxAngularVel: number
  speedSmoothing: number
  minRadius: number
  /** Distance at which homeward pull reaches full strength (no hard wall) */
  softRadius: number
}

export const DEFAULT_CONFIG: PhysicsConfig = {
  baseSpeed: 22,           // gentle continuous drift — cursors always wander even when no events stream in (event streaming is unreliable enough that "stationary by default" makes the dashboard look broken). Tool-call events still apply impulse boosts on top.
  torqueNoise: 0.35,       // moderate direction-change noise — natural meander
  homeTorque: 0.12,        // moderate pull — quadratic ramp makes it escalate naturally
  homeDeadzone: 60,        // no pull until fairly far out
  angularDamping: 0.15,    // heading stays locked — long straight lines
  maxAngularVel: 0.15,     // allow slightly sharper turns for natural curves back
  speedSmoothing: 0.08,    // very slow friction — speed settles toward baseSpeed over ~40-60s
  minRadius: 10,
  softRadius: 200,         // pull reaches full strength here; cursors can venture beyond
}
