import { useQueryClient, useMutation } from '@tanstack/react-query'
import { SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { useTopBarRightPortal } from '@/components/top-bar-slot'
import { useChatDetail } from '@/hooks/use-chat-detail'
import { apiFetch } from '@/lib/api-fetch'
import type { ChatDetail } from '@skill-networks/contracts/chat'

interface StageModeToggleProps {
  chatId: string
}

/**
 * Renders a "dials" button into the app top bar (left of the theme toggle)
 * with a dropdown containing the stage-mode switch. Uses optimistic updates
 * so the toggle responds immediately without waiting for the server — the
 * renderer choice in chat-room-interior reads from the same chat detail
 * query, so the optimistic cache write swaps the renderer instantly.
 */
export function StageModeToggle({ chatId }: StageModeToggleProps) {
  const { data: chatDetail } = useChatDetail(chatId)
  const enabled = chatDetail?.stageMode ?? false
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: async (next: boolean) => {
      const res = await apiFetch(`/api/chats/${chatId}/stage-mode`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '<unreadable>')
        throw new Error(`PATCH /stage-mode non-2xx ${res.status}: ${body.slice(0, 200)}`)
      }
    },
    onMutate: async (next: boolean) => {
      await queryClient.cancelQueries({ queryKey: ['chat', chatId] })
      const prev = queryClient.getQueryData<ChatDetail>(['chat', chatId])
      queryClient.setQueryData<ChatDetail>(['chat', chatId], (old) =>
        old ? { ...old, stageMode: next } : old,
      )
      return { prev }
    },
    onError: (_err, _next, ctx) => {
      if (ctx?.prev !== undefined) {
        queryClient.setQueryData(['chat', chatId], ctx.prev)
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['chat', chatId] }),
  })

  const onToggle = (next: boolean) => { mutation.mutate(next) }

  return useTopBarRightPortal(
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Display options"
          data-testid="stage-mode-toggle-trigger"
          className="text-muted-foreground hover:text-foreground transition-colors duration-150"
        >
          <SlidersHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44 p-2">
        <label className="flex items-center justify-between gap-3 px-1 py-1 text-xs text-foreground">
          <span>Stage manager</span>
          <Switch
            size="sm"
            checked={enabled}
            onCheckedChange={onToggle}
            aria-label={enabled ? 'Switch to single view' : 'Switch to stage manager'}
            data-testid="stage-mode-toggle"
          />
        </label>
      </DropdownMenuContent>
    </DropdownMenu>,
  )
}
