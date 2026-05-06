import { useQuery } from '@tanstack/react-query'
import { useSearch, useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { DEFAULT_SEARCH_PARAMS } from '@/adapters/layout/registry'
import { apiFetch } from '@/lib/api-fetch'

export function FilterBar({ className }: { className?: string }) {
  const { activeTypes = [] } = useSearch({ strict: false }) as { activeTypes?: string[] }
  const navigate = useNavigate()

  const { data: resourceTypes = [] } = useQuery<string[]>({
    queryKey: ['resource-types'],
    staleTime: Infinity,
    queryFn: () => apiFetch('/api/resource-types').then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }),
  })

  function toggleType(type: string) {
    const isActive = activeTypes.includes(type)
    const newTypes = isActive
      ? activeTypes.filter((t) => t !== type)
      : [...activeTypes, type]
    void navigate({ to: '/', search: (prev) => ({ ...DEFAULT_SEARCH_PARAMS, ...prev, activeTypes: newTypes }) })
  }

  function clearAll() {
    void navigate({ to: '/', search: (prev) => ({ ...DEFAULT_SEARCH_PARAMS, ...prev, activeTypes: [] as string[] }) })
  }

  return (
    <div className={cn('flex items-center gap-2 p-2 bg-background border-b', className)}>
      {resourceTypes.map((type) => {
        const isActive = activeTypes.includes(type)
        return (
          <Button
            key={type}
            variant={isActive ? 'default' : 'outline'}
            size="sm"
            onClick={() => toggleType(type)}
          >
            {type}
          </Button>
        )
      })}
      {activeTypes.length > 0 && (
        <Button variant="ghost" size="sm" onClick={clearAll}>
          Clear
        </Button>
      )}
    </div>
  )
}
