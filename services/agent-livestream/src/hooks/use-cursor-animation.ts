import { useEffect, useRef, useCallback } from 'react'
import {
  initCursorPhysics,
  stepPhysics,
  DEFAULT_CONFIG,
} from '@/lib/cursor-physics'
import type { CursorPhysicsState } from '@/lib/cursor-physics'
import { CLAUDE_CODE_TOOL_TIER_MAP, ToolTier } from '@contracts/tool-tiers'
import { getImpulseForTier } from '@/lib/cursor-impulse'

/**
 * Drives a single cursor's heading-based random walk with angular inertia.
 *
 * Writes to two DOM elements via refs — zero React re-renders:
 * - posRef: outer div gets translate(x, y)
 * - rotRef: inner wrapper gets rotate(deg) — only the cursor icon, not the badge
 */
export function useCursorAnimation(
  homeX: number,
  homeY: number,
  processId: string,
  posRef: React.RefObject<HTMLDivElement | null>,
  rotRef: React.RefObject<HTMLDivElement | null>,
) {
  const stateRef = useRef<CursorPhysicsState>(initCursorPhysics(homeX, homeY, processId))
  const rafRef = useRef<number | null>(null)
  const lastTimeRef = useRef<number | null>(null)
  const activeRef = useRef(true)
  const impulseRef = useRef<{ speedBoost: number; remainingMs: number } | null>(null)

  const prevHomeRef = useRef({ x: homeX, y: homeY })
  if (prevHomeRef.current.x !== homeX || prevHomeRef.current.y !== homeY) {
    prevHomeRef.current = { x: homeX, y: homeY }
    stateRef.current = initCursorPhysics(homeX, homeY, processId)
  }

  const applyPush = useCallback((source: string) => {
    // token_usage events encode token count as "token_usage:1234"
    // Parse it out and use as a scalar for impulse magnitude.
    let actualSource = source
    let tokenScalar = 1
    const colonIdx = source.indexOf(':')
    if (colonIdx > 0) {
      const maybeTokens = Number(source.slice(colonIdx + 1))
      if (!Number.isNaN(maybeTokens) && maybeTokens > 0) {
        actualSource = source.slice(0, colonIdx)
        // Scale: 100 tokens = 1x, 1000 tokens = ~2x, 10000 tokens = ~3x (log scale)
        tokenScalar = Math.max(1, Math.log10(maybeTokens / 10))
      }
    }
    const tier = CLAUDE_CODE_TOOL_TIER_MAP[actualSource] ?? ToolTier.generic
    const impulse = getImpulseForTier(tier)
    impulseRef.current = {
      speedBoost: impulse.speedBoost * tokenScalar,
      remainingMs: impulse.durationMs,
    }
  }, [])

  useEffect(() => {
    activeRef.current = true

    const animate = (now: DOMHighResTimeStamp) => {
      if (!activeRef.current) return

      const last = lastTimeRef.current ?? now
      const dt = Math.min((now - last) / 1000, 0.05)
      lastTimeRef.current = now

      let impulse: number | undefined = undefined
      if (impulseRef.current && impulseRef.current.remainingMs > 0) {
        impulse = impulseRef.current.speedBoost
        impulseRef.current.remainingMs = Math.max(0, impulseRef.current.remainingMs - dt * 1000)
        if (impulseRef.current.remainingMs <= 0) impulseRef.current = null
      }

      stateRef.current = stepPhysics(stateRef.current, dt, DEFAULT_CONFIG, impulse)

      const { x, y, heading } = stateRef.current
      // MousePointer2 tip at 0deg points upper-left = -135° from +x axis
      const angleDeg = (heading * 180 / Math.PI) + 135

      if (posRef.current) {
        posRef.current.style.transform = `translate(${x}px, ${y}px)`
      }
      if (rotRef.current) {
        rotRef.current.style.transform = `rotate(${angleDeg}deg)`
        rotRef.current.style.transformOrigin = '4px 4px'
      }

      rafRef.current = requestAnimationFrame(animate)
    }

    rafRef.current = requestAnimationFrame(animate)

    return () => {
      activeRef.current = false
      lastTimeRef.current = null
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
    // rAF loop restarts only when home position changes; posRef/rotRef are stable DOM refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeX, homeY])

  return applyPush
}
