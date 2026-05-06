/* eslint-disable react-refresh/only-export-components -- TanStack Router route files export Route (a config object) alongside the page component */
import { useState, useMemo } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ChatSummary } from '@skill-networks/contracts/chat'
import { apiFetch } from '@/lib/api-fetch'

export const Route = createFileRoute('/_authenticated/p/$projectName/tasks')({
  component: TasksPage,
})

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
  const days = Math.floor(hrs / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

async function fetchChats(): Promise<ChatSummary[]> {
  const res = await apiFetch('/api/chats')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<ChatSummary[]>
}

async function createChat(): Promise<ChatSummary> {
  const res = await apiFetch('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'New call' }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<ChatSummary>
}

function TasksPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')

  const { data: chats = [], isPending } = useQuery<ChatSummary[]>({
    queryKey: ['chats'],
    queryFn: fetchChats,
    placeholderData: (prev) => prev,
  })

  const mutation = useMutation({
    mutationFn: createChat,
    onSuccess: (chat) => {
      void queryClient.invalidateQueries({ queryKey: ['chats'] })
      void navigate({ to: '/chat/$id', params: { id: chat.id } })
    },
  })

  const filtered = useMemo(
    () => chats.filter((c) => c.title.toLowerCase().includes(search.toLowerCase())),
    [chats, search],
  )

  return (
    <div className="flex flex-col gap-4 p-6 max-w-2xl mx-auto w-full">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Chats</h1>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" data-testid="new-call-button">
              <Plus className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => mutation.mutate()}
              disabled={mutation.isPending}
            >
              New call
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Input
        placeholder="Search your chats..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="flex flex-col">
        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-muted-foreground">Your chats</span>
          <span className="text-sm text-muted-foreground">Select</span>
        </div>
        <Separator />
        {isPending && chats.length === 0 && (
          <div className="space-y-1 py-2">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex items-center justify-between py-3 px-1">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-16" />
              </div>
            ))}
          </div>
        )}
        {filtered.map((chat) => (
          <div key={chat.id}>
            <button
              type="button"
              className="w-full text-left py-3 hover:bg-muted/50 transition-colors duration-150 cursor-pointer"
              onClick={() => void navigate({ to: '/chat/$id', params: { id: chat.id } })}
            >
              <p className="text-sm font-medium">{chat.title}</p>
              <p className="text-xs text-muted-foreground">
                Last message {relativeTime(chat.createdAt)}
              </p>
            </button>
            <Separator />
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">No chats found.</p>
        )}
      </div>
    </div>
  )
}
