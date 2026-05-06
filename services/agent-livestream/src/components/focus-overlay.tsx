import { X } from 'lucide-react'

interface FocusOverlayProps {
  title: string
  onDismiss: () => void
  /** Right offset for dismiss button — accounts for overlaid sidebar width */
  rightOffset?: number
}

/** Liquid glass title pill (top-left) + dismiss button (top-right) — shared by agent and skill focus modes. */
export function FocusOverlay({ title, onDismiss, rightOffset = 0 }: FocusOverlayProps) {
  return (
    <>
      <div className="absolute top-3 left-3 z-50 rounded-xl backdrop-blur-md bg-muted/30 border border-border/40 px-3 py-1.5">
        <span className="text-sm font-medium text-foreground">{title}</span>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="absolute top-3 z-50 flex items-center justify-center rounded-xl backdrop-blur-md bg-muted/30 border border-border/40 h-8 w-8 text-muted-foreground hover:text-foreground transition-all duration-300"
        /* tokens-ok: right offset is a runtime value from sidebar width — no static equivalent */
        style={{ right: 12 + rightOffset } as React.CSSProperties}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </>
  )
}
