import type { CursorList } from '@/hooks/use-cursor-nodes'
import { agentColor } from '@/lib/agent-colors'
import { CURSOR_ORBIT_RADIUS_PX } from '@/constants'

export interface CursorData {
  x: number
  y: number
  color: ReturnType<typeof agentColor>
  name: string
  id: string
  lastTool: string | null
}

/** N > 1 cursors sharing a node orbit its center at CURSOR_ORBIT_RADIUS_PX; N == 1 sits at center. */
export function layoutCursors(
  cursorMap: Map<string, CursorList>,
  terrainPositions: Map<string, { x: number; y: number }>,
  latestEvents: Map<string, string>,
): CursorData[] {
  const result: CursorData[] = []
  for (const [resourceId, cursorList] of cursorMap) {
    const pos = terrainPositions.get(resourceId)
    if (!pos) continue
    const count = cursorList.length
    const radius = count > 1 ? CURSOR_ORBIT_RADIUS_PX : 0
    for (let i = 0; i < count; i++) {
      const cursor = cursorList[i]
      if (!cursor) continue
      const lastTool = latestEvents.get(cursor.process_id) ?? null
      const angle = count > 1 ? (i / count) * Math.PI * 2 - Math.PI / 2 : 0
      result.push({
        x: pos.x + Math.cos(angle) * radius,
        y: pos.y + Math.sin(angle) * radius,
        color: agentColor(cursor.process_id),
        name: cursor.process_name,
        id: cursor.process_id,
        lastTool,
      })
    }
  }
  return result
}
