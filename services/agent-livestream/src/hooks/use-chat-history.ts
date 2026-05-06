import { useQuery } from '@tanstack/react-query'
import { MessageRow } from '@skill-networks/contracts/chat'
import type { MessageRow as MessageRowType } from '@skill-networks/contracts/chat'
import { apiFetch } from '@/lib/api-fetch'

export function useChatHistory(chatId: string) {
  return useQuery<MessageRowType[]>({
    queryKey: ['chat-history', chatId],
    queryFn: async () => {
      const res = await apiFetch(`/api/chats/${chatId}/messages`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: unknown = await res.json()
      return MessageRow.array().parse(json)
    },
    staleTime: 30_000,
  })
}
