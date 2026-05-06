import { useState } from 'react'
import { ListFilter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'

const RESOURCE_TYPES = [
  'goal',
  'identity',
  'credential',
  'data',
  'app',
  'server',
  'proxy',
  'deployment',
  'config',
  'runtime',
  'database',
  'bucket',
  'url',
]

interface GraphFilterProps {
  activeTypes: Set<string>
  onToggle: (type: string) => void
}

export function GraphFilter({ activeTypes, onToggle }: GraphFilterProps) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <ListFilter className="h-4 w-4 mr-2" />
          Filter
          {activeTypes.size > 0 && (
            <span className="ml-2 rounded-full bg-primary text-primary-foreground text-xs px-1.5 py-0.5 leading-none">
              {activeTypes.size}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-0" align="start">
        <Command>
          <CommandInput placeholder="Filter by type…" />
          <CommandList>
            <CommandEmpty>No types found.</CommandEmpty>
            <CommandGroup>
              {RESOURCE_TYPES.map((type) => (
                <CommandItem
                  key={type}
                  value={type}
                  onSelect={() => onToggle(type)}
                >
                  <span className={activeTypes.has(type) ? 'font-semibold' : ''}>
                    {type}
                  </span>
                  {activeTypes.has(type) && (
                    <span className="ml-auto text-primary">✓</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
