import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api-fetch'
import { mapStateSnapshot } from '@/lib/state-snapshot-mapper'
import { TaskList } from '@/components/ui/task-list'
import type { EpochResult } from '@skill-networks/contracts/epochs'

interface EpochProgressProps {
  processId: string
}

export function EpochProgress({ processId }: EpochProgressProps) {
  const { data, isPending } = useQuery<EpochResult | null>({
    queryKey: ['epoch-latest', processId],
    queryFn: async () => {
      const res = await apiFetch(`/api/processes/${processId}/epochs/latest`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<EpochResult | null>
    },
    refetchInterval: 10_000,
  })

  const vm = mapStateSnapshot(data?.state_snapshot ?? null)

  if (isPending) return <div className="h-4 w-32 animate-pulse rounded bg-muted" />
  if (vm.stories.length === 0) return null

  return (
    <div className="text-xs">
      <TaskList stories={vm.stories} />
    </div>
  )
}
