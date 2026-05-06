import { ListFilter } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { MultiSelectList } from '@/components/ui/multi-select'
import { apiFetch } from '@/lib/api-fetch'

interface ActivityFilterProps {
  processId: string
  activeTypes: string[]
}

export function ActivityFilter({ processId, activeTypes }: ActivityFilterProps) {
  const navigate = useNavigate()

  const { data: resourceTypes = [] } = useQuery<string[]>({
    queryKey: ['resource-types'],
    staleTime: Infinity,
    queryFn: () =>
      apiFetch('/api/resource-types').then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      }),
  })

  const activeSet = new Set(activeTypes)

  function onToggle(type: string) {
    const newTypes = activeSet.has(type)
      ? activeTypes.filter((t) => t !== type)
      : [...activeTypes, type]
    void navigate({
      to: '/activity/$processId',
      params: { processId },
      search: { activeTypes: newTypes },
    })
  }

  const options = resourceTypes.map((t) => ({ value: t, label: t }))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" className="h-7 w-7">
          <ListFilter className="h-3.5 w-3.5" />
          {activeSet.size > 0 && (
            <span className="sr-only">{activeSet.size} active</span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48 p-1">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-sm flex items-center gap-2">
            <span className="flex-1">Resource type</span>
            {activeSet.size > 0 && (
              <span className="text-xs text-muted-foreground">{activeSet.size}</span>
            )}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="p-1 w-44">
            <MultiSelectList options={options} selected={activeSet} onToggle={onToggle} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
