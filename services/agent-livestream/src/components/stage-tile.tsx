import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface StageTileProps {
  /** Content to render inside the tile. */
  children: ReactNode
  /** When true, renders as a clickable PiP thumbnail — content becomes non-interactive. */
  pip?: boolean
  /** Called when the PiP tile is clicked to swap. */
  onSwap?: () => void
  className?: string
}

/**
 * Shared tile for main stage and PiP positions.
 *
 * Main: fills container, content is fully interactive.
 * PiP (mini): fixed aspect-video, pointer-events-none on children so clicks reach the swap button.
 */
export function StageTile({ children, pip, onSwap, className }: StageTileProps) {
  if (pip) {
    return (
      <button
        type="button"
        aria-label="Swap main and picture-in-picture"
        onClick={onSwap}
        className={cn(
          'aspect-video w-40 cursor-pointer overflow-hidden rounded-lg',
          'border border-border/50 bg-background/80 shadow-lg backdrop-blur-sm',
          'transition-transform hover:scale-105',
          className,
        )}
      >
        {/* pointer-events-none ONLY in mini/pip mode so iframes don't swallow clicks */}
        <div className="pointer-events-none h-full w-full">
          {children}
        </div>
      </button>
    )
  }

  return (
    <div className={cn('h-full w-full overflow-hidden', className)}>
      {children}
    </div>
  )
}
