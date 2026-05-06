import { useMemo, useCallback } from 'react'
import { useSearch, useNavigate } from '@tanstack/react-router'
import type { Resource } from '@skill-networks/agent-events'
import type { ActiveProcess } from './use-cursor-nodes'

export type FocusedItem =
  | { type: 'agent'; process: ActiveProcess }
  | { type: 'skill'; resource: Resource }
  | null

const MAX_FOCUS_ID_LENGTH = 256

export function useFocusParam(
  resources: Resource[],
  activeProcesses: ActiveProcess[],
): {
  focusedItem: FocusedItem
  setSkillFocus: (id: string) => void
  setAgentFocus: (id: string) => void
  clearFocus: () => void
} {
  const search = useSearch({ strict: false }) as { focusType?: string; focusId?: string }
  const focusType = search.focusType ?? ''
  const focusId = search.focusId ?? ''
  const navigate = useNavigate({ from: '/p/$projectName/' })

  const focusedItem = useMemo<FocusedItem>(() => {
    if (focusType === 'skill') {
      const resource = resources.find((r) => r.id === focusId)
      return resource ? { type: 'skill', resource } : null
    }
    if (focusType === 'agent') {
      const process = activeProcesses.find((p) => p.process_id === focusId)
      return process ? { type: 'agent', process } : null
    }
    return null
  }, [focusType, focusId, resources, activeProcesses])

  const setSkillFocus = useCallback((id: string) => {
    if (id.length >= MAX_FOCUS_ID_LENGTH) return
    // shared component used in multiple route contexts — cast to bypass route-specific search type inference
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void (navigate as (opts: any) => void)({ search: (prev: unknown) => ({ ...(prev as object), focusType: 'skill', focusId: id }) })
  }, [navigate])

  const setAgentFocus = useCallback((id: string) => {
    if (id.length >= MAX_FOCUS_ID_LENGTH) return
    // shared component used in multiple route contexts — cast to bypass route-specific search type inference
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void (navigate as (opts: any) => void)({ search: (prev: unknown) => ({ ...(prev as object), focusType: 'agent', focusId: id }) })
  }, [navigate])

  const clearFocus = useCallback(() => {
    // shared component used in multiple route contexts — cast to bypass route-specific search type inference
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void (navigate as (opts: any) => void)({ search: (prev: unknown) => ({ ...(prev as object), focusType: '', focusId: '' }) })
  }, [navigate])

  return { focusedItem, setSkillFocus, setAgentFocus, clearFocus }
}
