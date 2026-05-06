/* eslint-disable react-refresh/only-export-components -- utility helpers co-located with GraphFocuser for single-import ergonomics */
import { useEffect, useRef } from 'react'
import { useReactFlow } from '@xyflow/react'
import type { Edge, Viewport } from '@xyflow/react'
import type { Resource, ResourceLink } from '@skill-networks/agent-events'

export function linksToEdges(links: ResourceLink[], resources: Resource[], reversed = false, edgeStyle = 'straight', showArrows = true, linestyle = 'solid', treeDirection = 'TB', nodeStyle = 'orb'): Edge[] {
  const resMap = new Map(resources.map((r) => [r.id, r]))
  return links.map((link) => {
    const source = reversed ? link.from_id : link.to_id
    const target = reversed ? link.to_id : link.from_id
    return {
      id: link.id,
      source,
      target,
      type: 'skillEdge',
      ...(showArrows ? { markerEnd: { type: 'arrowclosed' as const, width: 12, height: 12 } } : {}),
      data: {
        sourceSize: (resMap.get(source)?.config as { size?: string } | null)?.size ?? 'md',
        targetSize: (resMap.get(target)?.config as { size?: string } | null)?.size ?? 'md',
        edgeStyle,
        linestyle,
        treeDirection,
        nodeStyle,
      },
    }
  })
}

// GraphFocuser must live inside ReactFlow provider to call useReactFlow()
export function GraphFocuser({ skillId, disabled }: { skillId: string | null; disabled?: boolean }) {
  const { fitView, getNodes, getViewport, setViewport } = useReactFlow()
  const prevRef = useRef<string | null>(null)
  const initializedRef = useRef(false)
  const savedViewportRef = useRef<Viewport | null>(null)
  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = skillId
    const wasInitialized = initializedRef.current
    initializedRef.current = true

    function focusNode(id: string) {
      const node = getNodes().find((n) => n.id === id)
      if (!node) return false
      if (!node.measured?.width || !node.measured?.height) return false
      fitView({ nodes: [{ id }], duration: 450, padding: 0.8, maxZoom: 2 })
      return true
    }

    const FOCUS_RETRY_MS = 50
    let attempt = 0
    const MAX_RETRIES = 8
    let aborted = false
    let retry: ReturnType<typeof setTimeout> | undefined
    function tryFocus(id: string) {
      if (aborted) return
      if (focusNode(id)) return
      if (attempt < MAX_RETRIES) {
        attempt++
        retry = setTimeout(() => tryFocus(id), FOCUS_RETRY_MS)
      }
    }
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        if (disabled) return
        if (skillId) {
          // Transitioning null → non-null: save viewport before zooming in
          if (prev === null) savedViewportRef.current = getViewport()
          tryFocus(skillId)
        } else if (wasInitialized && prev !== null) {
          // Transitioning non-null → null: restore saved viewport or fitView
          if (savedViewportRef.current) {
            void setViewport(savedViewportRef.current, { duration: 450 })
            savedViewportRef.current = null
          } else {
            fitView({ duration: 450, padding: 0.3 })
          }
        }
      })
    })
    return () => {
      aborted = true
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
      clearTimeout(retry)
    }
    // fitView/getNodes/getViewport/setViewport are stable refs — skillId change is the intent
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillId])
  return null
}
