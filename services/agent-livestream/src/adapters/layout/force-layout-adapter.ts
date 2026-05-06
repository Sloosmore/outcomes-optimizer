import { Workflow } from 'lucide-react'
import type { LayoutAdapter } from './types'

export const ForceLayoutAdapter: LayoutAdapter = {
  id: 'force',
  label: 'Force',
  icon: Workflow,
  // ForceController owns positions; radialLayout handles initial placement
  computeLayout: () => null,
}
