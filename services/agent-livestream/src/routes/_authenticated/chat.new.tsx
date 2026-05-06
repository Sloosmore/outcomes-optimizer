import { createFileRoute, redirect } from '@tanstack/react-router'
import { ChatSummary } from '@skill-networks/contracts/chat'
import { apiFetch } from '@/lib/api-fetch'

/**
 * `/chat/new` is a virtual route — it creates a fresh chat row in the BFF and
 * redirects to its real `/chat/<id>` URL. Previously this route minted a
 * client-side UUID and redirected without creating the row, so the agent
 * pipeline would fail to persist any messages (FK violation on
 * `messages.chat_id`) and the frontend silently rendered no bubbles.
 */
export const Route = createFileRoute('/_authenticated/chat/new')({
  beforeLoad: async () => {
    const res = await apiFetch('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New call' }),
    })
    if (!res.ok) {
      throw new Error(`POST /api/chats failed: ${res.status}`)
    }
    const summary = ChatSummary.parse(await res.json())
    throw redirect({
      to: '/chat/$id',
      params: { id: summary.id },
      search: {},
      replace: true,
    })
  },
})
