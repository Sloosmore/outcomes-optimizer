import { useEffect, useRef } from 'react'
import { useReactFlow, useStore, ViewportPortal } from '@xyflow/react'
import { selectZoom } from '@/lib/graph-constants'
import type { Resource } from '@skill-networks/agent-events'
import { TERRAIN_CURSOR_PROXIMITY_PX } from '@/constants'

/**
 * Google Maps-style labels on terrain peaks.
 *
 * Zoomed far out: large project name at centroid.
 * Zoomed in: individual resource names at peaks, fading when cursors are near.
 * Zoomed very close: all labels gone.
 */

const PROJECT_FADE_OUT_START = 0.35
const PROJECT_FADE_OUT_END = 0.5
const AGENT_FADE_IN_START = 0.4
const AGENT_FADE_IN_END = 0.55
const AGENT_FADE_OUT_START = 0.9
const AGENT_FADE_OUT_END = 1.3

function projectOpacity(zoom: number): number {
  if (zoom < PROJECT_FADE_OUT_START) return 1
  if (zoom < PROJECT_FADE_OUT_END) return 1 - (zoom - PROJECT_FADE_OUT_START) / (PROJECT_FADE_OUT_END - PROJECT_FADE_OUT_START)
  return 0
}

function agentOpacity(zoom: number): number {
  if (zoom < AGENT_FADE_IN_START) return 0
  if (zoom < AGENT_FADE_IN_END) return (zoom - AGENT_FADE_IN_START) / (AGENT_FADE_IN_END - AGENT_FADE_IN_START)
  if (zoom < AGENT_FADE_OUT_START) return 1
  if (zoom < AGENT_FADE_OUT_END) return 1 - (zoom - AGENT_FADE_OUT_START) / (AGENT_FADE_OUT_END - AGENT_FADE_OUT_START)
  return 0
}

interface TerrainLabelsProps {
  terrainPositions: Map<string, { x: number; y: number }>
  projectName?: string
  cursorRefsMap?: React.RefObject<Map<string, HTMLDivElement>>
}

export function TerrainLabels({ terrainPositions, projectName = 'skill-networks', cursorRefsMap }: TerrainLabelsProps) {
  const { getNodes } = useReactFlow()
  const zoom = useStore(selectZoom)
  const labelRefsMap = useRef<Map<string, SVGTextElement>>(new Map())

  // Fade labels when cursors pass nearby
  useEffect(() => {
    if (!cursorRefsMap?.current) return
    const interval = setInterval(() => {
      const cursors = cursorRefsMap.current
      if (!cursors) return
      const cursorPositions: { x: number; y: number }[] = []
      for (const el of cursors.values()) {
        const match = el.style.transform.match(/translate\(\s*([-\d.]+)px,\s*([-\d.]+)px/)
        if (match) cursorPositions.push({ x: parseFloat(match[1]), y: parseFloat(match[2]) })
      }
      for (const [id, textEl] of labelRefsMap.current) {
        const pos = terrainPositions.get(id)
        if (!pos) continue
        let minDist = Infinity
        for (const cp of cursorPositions) {
          const d = Math.sqrt((pos.x - cp.x) ** 2 + (pos.y - cp.y) ** 2)
          if (d < minDist) minDist = d
        }
        const fade = minDist < TERRAIN_CURSOR_PROXIMITY_PX ? Math.max(0, minDist / TERRAIN_CURSOR_PROXIMITY_PX) : 1
        textEl.style.opacity = String(fade * 0.7)
      }
    }, 100)
    return () => clearInterval(interval)
  }, [cursorRefsMap, terrainPositions])

  const rfNodes = getNodes()
  if (rfNodes.length === 0) return null

  let cx = 0, cy = 0
  for (const [, pos] of terrainPositions) { cx += pos.x; cy += pos.y }
  cx /= terrainPositions.size || 1
  cy /= terrainPositions.size || 1

  const pOpacity = projectOpacity(zoom) * 0.5
  const aOpacity = agentOpacity(zoom)

  return (
    <ViewportPortal>
      <svg className="pointer-events-none overflow-visible absolute top-0 left-0">
        {pOpacity > 0 && (
          <text
            x={cx} y={cy}
            textAnchor="middle" dominantBaseline="central"
            className="fill-muted-foreground font-bold"
            fontSize={60} opacity={pOpacity}
          >
            {projectName}
          </text>
        )}

        {aOpacity > 0 && rfNodes.map((n) => {
          const pos = terrainPositions.get(n.id)
          if (!pos) return null
          const resource = (n.data as { resource?: Resource }).resource
          if (!resource) return null
          const name = (resource.config as { display_name?: string } | null)?.display_name ?? resource.name

          return (
            <text
              key={n.id}
              ref={(el) => {
                if (el) labelRefsMap.current.set(n.id, el)
                else labelRefsMap.current.delete(n.id)
              }}
              x={pos.x} y={pos.y}
              textAnchor="middle" dominantBaseline="central"
              className="fill-muted-foreground font-semibold"
              fontSize={28} opacity={aOpacity * 0.7}
            >
              {name}
            </text>
          )
        })}
      </svg>
    </ViewportPortal>
  )
}
