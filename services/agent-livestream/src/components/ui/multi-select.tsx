import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

interface MultiSelectOption {
  value: string
  label: string
}

interface MultiSelectListProps {
  options: MultiSelectOption[]
  selected: Set<string>
  onToggle: (value: string) => void
  className?: string
}

export function MultiSelectList({ options, selected, onToggle, className }: MultiSelectListProps) {
  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="menuitemcheckbox"
          aria-checked={selected.has(opt.value)}
          className="flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-accent text-sm text-left w-full select-none cursor-default"
          onMouseDown={(e) => { e.preventDefault(); onToggle(opt.value) }}
        >
          <span className={cn(
            'h-3.5 w-3.5 rounded-sm border flex items-center justify-center flex-shrink-0',
            selected.has(opt.value) ? 'bg-primary border-primary' : 'border-input'
          )}>
            {selected.has(opt.value) && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
          </span>
          {opt.label}
        </button>
      ))}
    </div>
  )
}
