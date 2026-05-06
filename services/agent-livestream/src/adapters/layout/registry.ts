import { TreeLayoutAdapter } from './tree-layout-adapter'
import { ForceLayoutAdapter } from './force-layout-adapter'
import { TerrainLayoutAdapter } from './terrain-layout-adapter'
import type { LayoutAdapter } from './types'

export const LAYOUT_REGISTRY: Record<string, LayoutAdapter> = {
  tree: TreeLayoutAdapter,
  force: ForceLayoutAdapter,
  terrain: TerrainLayoutAdapter,
}

export const DEFAULT_LAYOUT = 'tree'

/** Spread-first default search params for `navigate()` calls — prevents stale state when params are added. */
export const DEFAULT_SEARCH_PARAMS = {
  layout: DEFAULT_LAYOUT,
  'tree.direction': 'TB' as string,
  cursors: '1',
  edges: 'step',
  orb: '1',
  arrows: '0',
  linestyle: 'solid',
  nodeStyle: 'card',
  focusType: '' as '' | 'skill' | 'agent',
  focusId: '',
  activeTypes: [] as string[],
}
