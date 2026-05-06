import { useQuery } from '@tanstack/react-query'
import { ChatDetail } from '@skill-networks/contracts/chat'
import type { ChatDetail as ChatDetailType } from '@skill-networks/contracts/chat'
import { apiFetch } from '@/lib/api-fetch'

export function useChatDetail(chatId: string) {
  return useQuery<ChatDetailType>({
    queryKey: ['chat', chatId],
    queryFn: async () => {
      const res = await apiFetch(`/api/chats/${chatId}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: unknown = await res.json()
      return ChatDetail.parse(json)
    },
    staleTime: 30_000,
  })
}
