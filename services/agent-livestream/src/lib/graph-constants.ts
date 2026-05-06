/** Base node sizes in px — multiplied by --graph-scale at render time. */
export const BASE_SIZE: Record<string, number> = { xl: 144, lg: 116, md: 80, sm: 52 }

/** Max label width per size tier — used by both layout (tree-layout-adapter) and render (skill-node). */
export const BASE_LABEL_WIDTH: Record<string, number> = { xl: 200, lg: 160, md: 120, sm: 100 }

/** Derived: half the base size, used for edge endpoint offsets. */
export const BASE_RADIUS: Record<string, number> = Object.fromEntries(
  Object.entries(BASE_SIZE).map(([k, v]) => [k, v / 2]),
)

/** Card node dimensions in px — used by dagre layout and edge routing.
 *  Height includes the orb overflow above the card (~half the orb diameter). */
export const CARD_NODE_WIDTH: Record<string, number> = { xl: 192, lg: 176, md: 160, sm: 128 }
export const CARD_NODE_HEIGHT: Record<string, number> = { xl: 140, lg: 128, md: 116, sm: 92 }
export const CARD_HALF_WIDTH: Record<string, number> = Object.fromEntries(
  Object.entries(CARD_NODE_WIDTH).map(([k, v]) => [k, v / 2]),
)
export const CARD_HALF_HEIGHT: Record<string, number> = Object.fromEntries(
  Object.entries(CARD_NODE_HEIGHT).map(([k, v]) => [k, v / 2]),
)

/** Read --graph-scale from the root element. Cached per caller — call sparingly. */
export function graphScale(): number {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--graph-scale')) || 1
}

/**
 * ReactFlow zoom selector — quantized to avoid re-renders on sub-pixel changes.
 * Use with `useStore(selectZoom)` inside ReactFlow components.
 */
export const selectZoom = (s: { transform: [number, number, number] }): number =>
  Math.round(s.transform[2] * 50) / 50
