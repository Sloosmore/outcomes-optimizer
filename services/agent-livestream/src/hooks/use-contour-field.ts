import { useMemo } from 'react'
import { useReactFlow } from '@xyflow/react'
import { contours } from 'd3-contour'
import { geoPath } from 'd3-geo'
import { createNoise2D } from 'simplex-noise'
import type { Resource, ResourceLink } from '@skill-networks/agent-events'

const GRID_RES = 180
const PADDING = 2400
const THRESHOLDS = 16

import { mulberry32, hashString as seedFromString } from '@/lib/seeded-rng'

export interface ContourPath {
  d: string
  value: number
}

export interface ContourResult {
  paths: ContourPath[]
  /** Maps node ID → terrain-space position (with spread + jitter applied) */
  terrainPositions: Map<string, { x: number; y: number }>
}

/**
 * Computes contour paths from current node positions.
 * Recomputes only when nodeKey changes (node set or position snapshot).
 */
export function useContourField(
  projectId: string,
  links: ResourceLink[],
  nodeKey: string,
): ContourResult {
  const { getNodes } = useReactFlow()

  return useMemo((): ContourResult => {
    const rfNodes = getNodes()
    if (rfNodes.length === 0) return { paths: [], terrainPositions: new Map() }

    // Spread factor — pushes peaks apart from centroid for terrain mode
    const SPREAD = 1.8

    // Compute centroid then scale positions outward
    let cx = 0, cy = 0
    for (const n of rfNodes) { cx += n.position.x; cy += n.position.y }
    cx /= rfNodes.length
    cy /= rfNodes.length

    // Scaled positions — spread outward from centroid
    const terrainPos = rfNodes.map((n) => ({
      x: cx + (n.position.x - cx) * SPREAD,
      y: cy + (n.position.y - cy) * SPREAD,
    }))

    // Bounding box from spread positions
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of terrainPos) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
    minX -= PADDING
    minY -= PADDING
    maxX += PADDING
    maxY += PADDING

    const width = maxX - minX
    const height = maxY - minY
    if (width <= 0 || height <= 0) return { paths: [], terrainPositions: new Map() }

    const rng = mulberry32(seedFromString(projectId))
    const noise2D = createNoise2D(rng)

    const gridW = GRID_RES
    const gridH = Math.max(2, Math.round(GRID_RES * (height / width)))
    const field = new Float64Array(gridW * gridH)

    // Tighter spreads so each node forms a distinct peak
    const sizeSpread: Record<string, number> = { xl: 120, lg: 90, md: 60, sm: 40 }
    const sizeWeight: Record<string, number> = { xl: 1.0, lg: 0.75, md: 0.5, sm: 0.3 }

    const peaks = rfNodes.map((n, i) => {
      const config = (n.data as { resource?: Resource }).resource?.config
      const size = (config?.['size'] as string | undefined) ?? 'md'
      const value = (config?.['value'] as number | undefined) ?? 50
      const pos = terrainPos[i]
      return {
        id: n.id,
        gx: ((pos.x - minX) / width) * gridW,
        gy: ((pos.y - minY) / height) * gridH,
        spread: ((sizeSpread[size] ?? 60) / width) * gridW,
        weight: (sizeWeight[size] ?? 0.5) * Math.max(value / 100, 0.15),
      }
    })

    const peakMap = new Map(peaks.map((p) => [p.id, p]))

    // Build ridges along parent-child links
    type Ridge = { x1: number; y1: number; x2: number; y2: number; weight: number; width: number }
    const ridges: Ridge[] = []
    const nodeIds = new Set(rfNodes.map((n) => n.id))
    for (const link of links) {
      if (!nodeIds.has(link.from_id) || !nodeIds.has(link.to_id)) continue
      const from = peakMap.get(link.from_id)
      const to = peakMap.get(link.to_id)
      if (!from || !to) continue
      ridges.push({
        x1: from.gx, y1: from.gy,
        x2: to.gx, y2: to.gy,
        weight: Math.min(from.weight, to.weight) * 0.12,
        width: Math.max(from.spread, to.spread) * 0.25,
      })
    }

    // Fill scalar field
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        let elevation = 0

        // Gaussian peaks
        for (const peak of peaks) {
          const dx = x - peak.gx
          const dy = y - peak.gy
          const distSq = dx * dx + dy * dy
          const sigma = peak.spread
          elevation += peak.weight * Math.exp(-distSq / (2 * sigma * sigma))
        }

        // Ridges along edges — Gaussian falloff from line segment
        for (const ridge of ridges) {
          const ex = ridge.x2 - ridge.x1
          const ey = ridge.y2 - ridge.y1
          const lenSq = ex * ex + ey * ey
          if (lenSq === 0) continue
          // Project point onto line segment, clamp t to [0,1]
          const t = Math.max(0, Math.min(1, ((x - ridge.x1) * ex + (y - ridge.y1) * ey) / lenSq))
          const px = ridge.x1 + t * ex
          const py = ridge.y1 + t * ey
          const dx = x - px
          const dy = y - py
          const distSq2 = dx * dx + dy * dy
          const sigma = ridge.width
          elevation += ridge.weight * Math.exp(-distSq2 / (2 * sigma * sigma))
        }

        // Seeded Perlin noise for geological texture
        elevation += noise2D(x * 0.04, y * 0.04) * 0.06
        elevation += noise2D(x * 0.12, y * 0.12) * 0.02

        field[y * gridW + x] = elevation
      }
    }

    // Generate contour polygons
    const contourGen = contours().size([gridW, gridH]).thresholds(THRESHOLDS)
    const features = contourGen(Array.from(field))

    // Project grid coords back to graph coords
    const pathGen = geoPath().projection({
      stream: (s) => ({
        point(px: number, py: number) {
          s.point(minX + (px / gridW) * width, minY + (py / gridH) * height)
        },
        sphere() { s.sphere?.() },
        lineStart() { s.lineStart() },
        lineEnd() { s.lineEnd() },
        polygonStart() { s.polygonStart() },
        polygonEnd() { s.polygonEnd() },
      }),
    })

    // Build terrain position map — maps node ID to spread+jittered coordinates
    const terrainPositions = new Map<string, { x: number; y: number }>()
    for (let i = 0; i < rfNodes.length; i++) {
      terrainPositions.set(rfNodes[i].id, terrainPos[i])
    }

    const paths = features.map((f) => ({ d: pathGen(f) ?? '', value: f.value }))
    return { paths, terrainPositions }
    // Recompute only when node set or positions change — NOT on pan/zoom
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, nodeKey])
}
