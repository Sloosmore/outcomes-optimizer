import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@skill-networks/logger'
import type { EventEmitterAdapter, EmitInput } from '../interfaces.js'

const logger = createLogger('agent-events')

export class SupabaseEventEmitterAdapter implements EventEmitterAdapter {
  private client: SupabaseClient

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.client = createClient(supabaseUrl, supabaseKey)
  }

  emit(event: EmitInput): void {
    // fire and forget — never throws, never blocks
    const row = {
      ...event,
      id: globalThis.crypto.randomUUID(),
      ts: new Date().toISOString()
    }
    void Promise.resolve(
      this.client
        .from('agent_events')
        .insert(row)
    ).then(({ error }) => {
      if (error) {
        // swallow — observability must never block credential injection
        logger.error('emit error', new Error(error.message))
      }
    }).catch((err: unknown) => {
      // swallow — observability must never block credential injection
      logger.error('transport error', err instanceof Error ? err : new Error(String(err)))
    })
  }
}
