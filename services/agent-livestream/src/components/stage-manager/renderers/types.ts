import type { ArtifactTile } from '@skill-networks/contracts/chat'
import type { ComponentType } from 'react'

/**
 * Renderer interface. Both stage-renderer (multi-iframe) and single-renderer
 * (one full-bleed iframe) implement this exact contract so the parent can
 * swap them based on a user-controlled toggle without conditional logic.
 */
export interface ArtifactRendererProps {
  tiles: ArtifactTile[]
  onActivate: (url: string) => void
  /** When false, only the active tile is rendered full-bleed (no rail). */
  stageMode?: boolean
}

export type ArtifactRenderer = ComponentType<ArtifactRendererProps>
