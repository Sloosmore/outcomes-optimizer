import { createContext, useContext } from 'react'
import { createPortal } from 'react-dom'

export const TopBarRightSlotContext = createContext<HTMLElement | null>(null)

export function useTopBarRightPortal(content: React.ReactNode): React.ReactPortal | null {
  const el = useContext(TopBarRightSlotContext)
  if (!el) return null
  return createPortal(content, el)
}
