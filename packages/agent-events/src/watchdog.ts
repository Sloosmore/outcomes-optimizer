/// <reference types="node" />
import { createClient } from '@supabase/supabase-js'
import { createEventService } from './event-service.js'
import type { EventEmitterAdapter } from './interfaces.js'
import { EventType } from './event-types.js'

// env access via globalThis to avoid requiring Node types when compiled with browser tsconfig
declare const process: { env: Record<string, string | undefined> } | undefined

export function createWatchdog(
  processId: string,
  thresholdMs = 900000
): { stop(): void } {
  const env = (typeof process !== 'undefined' ? process.env : {}) as Record<string, string | undefined>
  const supabaseUrl = env['SUPABASE_URL']
  const supabaseKey = env['SUPABASE_SERVICE_KEY']

  if (!supabaseUrl || !supabaseKey) {
    return { stop() {} }
  }

  const emitter = createEventService()
  if (!emitter) {
    return { stop() {} }
  }

  const safeEmitter: EventEmitterAdapter = emitter

  const client = createClient(supabaseUrl, supabaseKey)

  let timer: ReturnType<typeof setTimeout>

  function resetTimer(): void {
    clearTimeout(timer)
    timer = setTimeout(() => {
      safeEmitter.emit({
        source: EventType.PROCESS_STALE,
        payload: { process_id: processId, threshold_ms: thresholdMs },
        resource_id: null,
        process_id: processId,
        process_name: env['EVAL_PROCESS'] ?? ''
      })
    }, thresholdMs)
  }

  const channel = client
    .channel(`watchdog:${processId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'agent_events',
        filter: `process_id=eq.${processId}`
      },
      () => {
        resetTimer()
      }
    )

  channel.subscribe()

  resetTimer()

  return {
    stop() {
      clearTimeout(timer)
      void client.removeChannel(channel)
    }
  }
}
