import { Wallpaper } from '../wallpaper'
import { StageWindow } from '../stage-window'
import { getSlot } from '../slot-math'
import type { ArtifactRendererProps } from './types'

/**
 * Stage Manager renderer: wallpaper + one StageWindow per tile, with index 0
 * as the active (large) tile and the rest stacked in a left rail.
 *
 * Iframes are keyed by URL so React keeps them mounted across reorderings —
 * the slot transition is purely a CSS transform on the wrapper. No client-side
 * activeIndex state: clicking a rail tile POSTs to the server, which rewrites
 * the array; React Query invalidation re-renders with the new order.
 */
export function StageRenderer({ tiles, onActivate, stageMode = true }: ArtifactRendererProps) {
  if (tiles.length === 0) {
    return (
      <div className="relative h-full w-full overflow-hidden">
        <Wallpaper />
      </div>
    )
  }

  // When stage mode is off, only render the active tile full-bleed (no rail).
  // We still mount via StageWindow so the iframe DOM node is preserved across
  // toggles — same React tree, same key, no reload.
  const visible = stageMode ? tiles : tiles.slice(0, 1)
  const totalCount = visible.length

  return (
    <div className="relative h-full w-full overflow-hidden">
      {stageMode && <Wallpaper />}
      {visible.map((tile, index) => (
        <StageWindow
          key={tile.url}
          url={tile.url}
          slot={getSlot(index, totalCount)}
          onActivate={() => onActivate(tile.url)}
        />
      ))}
    </div>
  )
}
