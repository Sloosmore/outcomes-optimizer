/// <reference types="node" />
import { SupabaseEventEmitterAdapter } from './adapters/supabase-event-emitter.js'
import type { EventEmitterAdapter, EmitInput } from './interfaces.js'

/**
 * Wrapper adapter that pre-fills process_id and process_name from env,
 * delegating the actual emit to the underlying adapter.
 * Callers only need to pass { source, payload, resource_id }.
 */
class PrefilledEventEmitterAdapter implements EventEmitterAdapter {
  private readonly inner: EventEmitterAdapter
  private readonly processId: string
  private readonly processName: string

  constructor(inner: EventEmitterAdapter, processId: string, processName: string) {
    this.inner = inner
    this.processId = processId
    this.processName = processName
  }

  emit(event: EmitInput): void {
    this.inner.emit({
      ...event,
      process_id: this.processId,
      process_name: this.processName
    })
  }
}

/**
 * Factory that constructs an EventEmitterAdapter from environment variables.
 * Returns null when any required credential is absent — callers should treat
 * null as "observability disabled" and skip emit calls.
 *
 * The returned adapter pre-fills process_id and process_name from env so
 * callers only need to pass { source, payload, resource_id }.
 */
// env access via globalThis to avoid requiring Node types when compiled with browser tsconfig
declare const process: { env: Record<string, string | undefined> } | undefined

export function createEventService(): EventEmitterAdapter | null {
  const env = (typeof process !== 'undefined' ? process.env : {}) as Record<string, string | undefined>
  const supabaseUrl = env['SUPABASE_URL']
  const supabaseKey = env['SUPABASE_SERVICE_KEY']
  const processId = env['EVAL_PROCESS_ID']
  const processName = env['EVAL_PROCESS']

  if (!supabaseUrl || !supabaseKey || !processId || !processName) {
    return null
  }

  const inner = new SupabaseEventEmitterAdapter(supabaseUrl, supabaseKey)
  return new PrefilledEventEmitterAdapter(inner, processId, processName)
}
