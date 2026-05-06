import { useMemo } from 'react'
import { useTextStream } from './use-conversation.js'
import { WorkerHeartbeat } from '@skill-networks/contracts/livekit'
import type { WorkerHeartbeat as WorkerHeartbeatType } from '@skill-networks/contracts/livekit'

/**
 * Subscribes to `worker_heartbeat` text stream and returns
 * the latest validated heartbeat or null.
 */
export function useWorkerStatus(): WorkerHeartbeatType | null {
  const { textStreams } = useTextStream('worker_heartbeat')

  const latest = useMemo(() => {
    const last = textStreams[textStreams.length - 1]
    if (!last) return null

    try {
      const parsed = WorkerHeartbeat.safeParse(JSON.parse(last.text))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }, [textStreams])

  return latest
}
