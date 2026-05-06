import { useState, useRef, useMemo, useEffect } from 'react'
import { useStore, useReactFlow, ViewportPortal } from '@xyflow/react'
import type { ResourceLink } from '@skill-networks/agent-events'
import { useContourField } from '@/hooks/use-contour-field'
import { useCursorFollowCamera } from '@/hooks/use-cursor-follow'
import { useTheme } from '@/hooks/use-theme'
import type { CursorList } from '@/hooks/use-cursor-nodes'
import { TerrainCursors } from '@/components/terrain-cursors'
import { TerrainLabels } from '@/components/terrain-labels'

interface ContourTerrainProps {
  projectId: string
  links: ResourceLink[]
  cursorMap: Map<string, CursorList>
  followedId?: string | null
  onFollow?: (id: string) => void
  registerRef?: (id: string, el: HTMLDivElement | null) => void
  cursorRefsMap?: React.RefObject<Map<string, HTMLDivElement>>
  isProgrammaticMove?: React.MutableRefObject<boolean>
}

function useSettledPositionKey(): string {
  const { getNodes } = useReactFlow()
  const [settledKey, setSettledKey] = useState('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nodeCount = useStore((s) => s.nodeLookup.size)

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      const rfNodes = getNodes()
      if (rfNodes.length === 0) return
      const key = rfNodes
        .map((n) => `${n.id}:${Math.round(n.position.x / 10)},${Math.round(n.position.y / 10)}`)
        .join('|')
      setSettledKey(key)
    }, 800)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
    // nodeCount triggers the debounce; getNodes is a stable ReactFlow ref — no need to list it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeCount])

  return settledKey
}

export function ContourTerrain({ projectId, links, cursorMap, followedId, onFollow, registerRef, cursorRefsMap, isProgrammaticMove }: ContourTerrainProps) {
  const { setCenter } = useReactFlow()
  const nodeKey = useSettledPositionKey()
  const { paths, terrainPositions } = useContourField(projectId, links, nodeKey)

  // Camera follow — runs inside ReactFlow context
  const emptyMap = useRef(new Map<string, HTMLDivElement>())
  const defaultFlag = useRef(false)
  useCursorFollowCamera(followedId ?? null, cursorRefsMap ?? emptyMap, setCenter, isProgrammaticMove ?? defaultFlag)

  const maxVal = useMemo(
    () => paths.reduce((max, p) => Math.max(max, p.value), 0.01),
    [paths],
  )

  const theme = useTheme()
  const isDark = theme === 'dark'

  return (
    <>
      <ViewportPortal>
        <svg className="pointer-events-none overflow-visible absolute top-0 left-0">
          {paths.map((p, i) => {
            const t = p.value / maxVal
            const alpha = isDark
              ? 0.15 + 0.35 * t
              : 0.2 + 0.4 * t
            /* tokens-ok: contour stroke is muted-foreground at dynamic elevation alpha — no static Tailwind equivalent */
            const stroke = isDark
              ? `rgba(180,180,180,${alpha})`
              : `rgba(40,40,40,${alpha})`
            return (
              <path
                key={i}
                d={p.d}
                fill="none"
                stroke={stroke}
                strokeWidth={0.8}
              />
            )
          })}
        </svg>
      </ViewportPortal>
      <TerrainLabels terrainPositions={terrainPositions} cursorRefsMap={cursorRefsMap} />
      <TerrainCursors
        cursorMap={cursorMap}
        terrainPositions={terrainPositions}
        followedId={followedId}
        onFollow={onFollow}
        registerRef={registerRef}
      />
    </>
  )
}
