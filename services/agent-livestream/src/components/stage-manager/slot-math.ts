/**
 * Stage Manager slot geometry. Pure function; no React. Active tile occupies
 * the main area; rail tiles stack down a fixed-width column on the left.
 *
 * Coords are returned as Tailwind-friendly percentage strings on a 0..100 box.
 * Returning strings (rather than px) keeps the parent flexible — the
 * StageManager root sets size via flex/grid; tiles position absolutely.
 */
export interface Slot {
  /** Distance from the parent's left edge (CSS string, e.g. "0%" or "12px"). */
  left: string
  /** Distance from the parent's top edge. */
  top: string
  /** Tile width. */
  width: string
  /** Tile height. */
  height: string
  /** Whether this tile is the active (large) one. */
  isActive: boolean
}

/** Visual constants. Pixel values pair with `transition-all` for smooth swaps. */
export const RAIL_WIDTH_PX = 180        // column for inactive tiles
export const RAIL_PADDING_PX = 20
export const RAIL_GAP_PX = 16
/** Rail tile inner width (the iframe's visual width, after column padding). */
export const RAIL_TILE_WIDTH_PX = RAIL_WIDTH_PX - 2 * RAIL_PADDING_PX
/** 16:9 thumbnail height — derived from the rail tile width so visual ratio
 * matches what most artifact sources target (laptop-class screens, slide
 * decks). Previously hardcoded to 120 (≈ 7:6) which squished wide content. */
export const RAIL_TILE_HEIGHT_PX = Math.round(RAIL_TILE_WIDTH_PX * 9 / 16)
/** Iframe natural-size dimensions for thumbnail rendering. The iframe lays
 * out at this size and is visually scaled down via CSS transform so inner
 * HTML keeps its real layout instead of reflowing into the tiny rail box.
 * NOTE: THUMB_NATURAL_HEIGHT_PX is mirrored in src/index.css :root --rail-thumb-h;
 * update both together. */
export const THUMB_NATURAL_WIDTH_PX = 1280
export const THUMB_NATURAL_HEIGHT_PX = 720
/** Padding around the active tile so the wallpaper shows on all sides. */
export const ACTIVE_INSET_PX = 32

/**
 * Compute the slot for tile `index` given `totalCount` tiles.
 *
 * - Index 0 (always active): occupies everything to the right of the rail.
 * - Index 1..N-1: stacked top-to-bottom in the rail column on the left.
 *
 * If totalCount is 1, the single tile fills the container — no rail.
 */
export function getSlot(index: number, totalCount: number): Slot {
  const isActive = index === 0
  if (totalCount <= 1) {
    return { left: '0px', top: '0px', width: '100%', height: '100%', isActive: true }
  }
  if (isActive) {
    // Inset the active tile so the wallpaper shows on all four sides
    // (iPad Stage Manager aesthetic).
    return {
      left: `${RAIL_WIDTH_PX + ACTIVE_INSET_PX}px`,
      top: `${ACTIVE_INSET_PX}px`,
      width: `calc(100% - ${RAIL_WIDTH_PX + 2 * ACTIVE_INSET_PX}px)`,
      height: `calc(100% - ${2 * ACTIVE_INSET_PX}px)`,
      isActive: true,
    }
  }
  // Rail tile — index 1 sits at the top of the rail.
  const railIndex = index - 1
  const top = RAIL_PADDING_PX + railIndex * (RAIL_TILE_HEIGHT_PX + RAIL_GAP_PX)
  return {
    left: `${RAIL_PADDING_PX}px`,
    top: `${top}px`,
    width: `${RAIL_WIDTH_PX - 2 * RAIL_PADDING_PX}px`,
    height: `${RAIL_TILE_HEIGHT_PX}px`,
    isActive: false,
  }
}
