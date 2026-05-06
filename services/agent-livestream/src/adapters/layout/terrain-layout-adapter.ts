import { Mountain } from 'lucide-react'
import type { LayoutAdapter } from './types'

export const TerrainLayoutAdapter: LayoutAdapter = {
  id: 'terrain',
  label: 'Terrain',
  icon: Mountain,
  // ForceController owns positions; terrain view renders contour lines on top
  computeLayout: () => null,
}
