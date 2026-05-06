import { useMemo } from 'react'
import { useTextStream } from './use-conversation.js'
import { BackgroundTaskUpdate } from '@skill-networks/contracts/livekit'
import type { BackgroundTaskUpdate as BackgroundTaskUpdateType } from '@skill-networks/contracts/livekit'

export function useBackgroundTask(): BackgroundTaskUpdateType | null {
  const { textStreams } = useTextStream('background_task_update')

  return useMemo(() => {
    const last = textStreams[textStreams.length - 1]
    if (!last) return null
    try {
      const parsed = BackgroundTaskUpdate.safeParse(JSON.parse(last.text))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }, [textStreams])
}
