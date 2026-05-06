import { useMemo } from 'react'
import { useTextStream } from './use-conversation.js'
import { WorkerError } from '@skill-networks/contracts/livekit'

/**
 * Subscribes to `worker_error` text stream and returns
 * the latest validated error message or null.
 */
export function useWorkerError(): string | null {
  const { textStreams } = useTextStream('worker_error')

  const errorMessage = useMemo(() => {
    const last = textStreams[textStreams.length - 1]
    if (!last) return null

    try {
      const parsed = WorkerError.safeParse(JSON.parse(last.text))
      return parsed.success ? parsed.data.message : null
    } catch {
      return null
    }
  }, [textStreams])

  return errorMessage
}
