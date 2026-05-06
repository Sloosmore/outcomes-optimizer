import { SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { LAYOUT_REGISTRY } from '@/adapters/layout/registry'
import type { LayoutAdapter } from '@/adapters/layout/types'

interface DisplayOptionsProps {
  activeAdapter: LayoutAdapter
  params: URLSearchParams
  setParam: (key: string, value: string) => void
}

export function DisplayOptions({ activeAdapter, params, setParam }: DisplayOptionsProps) {
  const layouts = Object.values(LAYOUT_REGISTRY)
  const isTerrain = activeAdapter.id === 'terrain'
  const isForce = activeAdapter.id === 'force' || isTerrain
  const nodeStyle = params.get('nodeStyle') ?? 'card'
  const cursorsOn = params.get('cursors') !== '0'
  const edgeStyle = params.get('edges') ?? 'step'
  const orbOn = params.get('orb') !== '0'
  const arrowsOn = params.get('arrows') !== '0'
  const linestyle = params.get('linestyle') ?? 'solid'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7">
          <SlidersHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52 p-2 space-y-2">

        {/* Layout section — tabs with icon tooltips */}
        <DropdownMenuLabel className="text-xs text-secondary-foreground px-1 py-0">Layout</DropdownMenuLabel>
        <TooltipProvider>
          <Tabs value={activeAdapter.id} onValueChange={(v) => setParam('layout', v)} className="gap-0">
            <TabsList className="w-full">
              {layouts.map((adapter) => {
                const Icon = adapter.icon
                return (
                  <Tooltip key={adapter.id}>
                    <TooltipTrigger asChild>
                      <span className="flex-1 flex h-full items-center">
                        <TabsTrigger value={adapter.id} className="w-full">
                          <Icon className="h-3.5 w-3.5" />
                        </TabsTrigger>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}>
                      {adapter.label}
                    </TooltipContent>
                  </Tooltip>
                )
              })}
            </TabsList>
          </Tabs>
        </TooltipProvider>

        {/* Adapter-specific controls (e.g. TB/LR direction for Tree) */}
        {!isTerrain && activeAdapter.renderControls && (
          <div className="space-y-1">
            {activeAdapter.controlsLabel && (
              <DropdownMenuLabel className="text-xs text-secondary-foreground px-1 py-0">{activeAdapter.controlsLabel}</DropdownMenuLabel>
            )}
            {activeAdapter.renderControls(params, setParam)}
          </div>
        )}

        {!isTerrain && (
          <>
            <Separator />

            {/* Connections section */}
            <DropdownMenuLabel className="text-xs text-secondary-foreground px-1 py-0">Connections</DropdownMenuLabel>

            {!isForce && (
              <ToggleGroup type="single" value={edgeStyle} onValueChange={(v) => v && setParam('edges', v)} className="w-full gap-1">
                <ToggleGroupItem value="bracket" className="flex-1 text-xs h-7 px-2">Bracket</ToggleGroupItem>
                <ToggleGroupItem value="step" className="flex-1 text-xs h-7 px-2">Step</ToggleGroupItem>
                <ToggleGroupItem value="straight" className="flex-1 text-xs h-7 px-2">Direct</ToggleGroupItem>
              </ToggleGroup>
            )}

            <ToggleGroup type="single" value={linestyle} onValueChange={(v) => v && setParam('linestyle', v)} className="w-full gap-1">
              <ToggleGroupItem value="solid" className="flex-1 text-xs h-7 px-2">Solid</ToggleGroupItem>
              <ToggleGroupItem value="dashed" className="flex-1 text-xs h-7 px-2">Dashed</ToggleGroupItem>
            </ToggleGroup>

            <div className="flex items-center justify-between px-1">
              <span className="text-xs text-foreground">Arrows</span>
              <Switch checked={arrowsOn} onCheckedChange={(v) => setParam('arrows', v ? '1' : '0')} className="scale-75 origin-right" />
            </div>

            <Separator />

            {/* Display section */}
            <DropdownMenuLabel className="text-xs text-secondary-foreground px-1 py-0">Display</DropdownMenuLabel>

            <ToggleGroup type="single" value={nodeStyle} onValueChange={(v) => v && setParam('nodeStyle', v)} className="w-full gap-1">
              <ToggleGroupItem value="card" className="flex-1 text-xs h-7 px-2">Card</ToggleGroupItem>
              <ToggleGroupItem value="orb" className="flex-1 text-xs h-7 px-2">Orb</ToggleGroupItem>
            </ToggleGroup>

            <div className="flex items-center justify-between px-1">
              <span className="text-xs text-foreground">Orb</span>
              <Switch checked={orbOn} onCheckedChange={(v) => setParam('orb', v ? '1' : '0')} className="scale-75 origin-right" />
            </div>
          </>
        )}

        <Separator />

        <div className="flex items-center justify-between px-1">
          <span className="text-xs text-foreground">Agent cursors</span>
          <Switch checked={cursorsOn} onCheckedChange={(v) => setParam('cursors', v ? '1' : '0')} className="scale-75 origin-right" />
        </div>

      </DropdownMenuContent>
    </DropdownMenu>
  )
}
