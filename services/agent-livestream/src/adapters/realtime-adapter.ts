import type { SupabaseClient } from '@supabase/supabase-js'
import type { ZodType } from 'zod'
import type { SessionAdapter } from '@duoidal/auth/adapters'

export interface RealtimeAdapter<T> {
  subscribe(onEvent: (e: T) => void): () => void
}

export class TableRealtimeAdapter<T> implements RealtimeAdapter<T> {
  private table: string
  private schema: ZodType<T>
  private client: SupabaseClient
  private authAdapter: SessionAdapter | null

  constructor(
    table: string,
    schema: ZodType<T>,
    client: SupabaseClient,
    authAdapter: SessionAdapter | null,
  ) {
    this.table = table
    this.schema = schema
    this.client = client
    this.authAdapter = authAdapter
  }

  subscribe(onEvent: (e: T) => void): () => void {
    let cancelled = false
    let channelCleanup: (() => void) | null = null
    let signingIn = true

    const authUnsubscribe = this.authAdapter?.onAuthStateChange((session) => {
      if (!session && !signingIn) {
        signingIn = true
        void this.authAdapter!.signIn().finally(() => { signingIn = false })
      }
    })

    const connectChannel = () => {
      if (cancelled) return
      // Unique channel name prevents collision when multiple subscribers call subscribe()
      // for the same table — duplicate names would silently drop the second subscriber.
      const channelId = crypto.randomUUID()
      const channel = this.client
        .channel(`realtime:${this.table}:${channelId}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: this.table },
          (payload) => {
            const result = this.schema.safeParse(payload.new)
            if (result.success) {
              onEvent(result.data)
            } else if (import.meta.env.DEV) {
              console.warn(`[RealtimeAdapter] Failed to parse ${this.table} event:`, result.error.issues)
            }
          },
        )
        .subscribe()

      channelCleanup = () => {
        void channel.unsubscribe()
      }

      if (cancelled) {
        channelCleanup()
        channelCleanup = null
      }
    }

    if (this.authAdapter) {
      void this.authAdapter.signIn().then(({ error }) => {
        if (error) {
          console.error('[RealtimeAdapter] signIn error:', error)
          return
        }
        connectChannel()
      }).catch((err: unknown) => {
        console.error('[RealtimeAdapter] Auth failed, cannot subscribe:', err)
      }).finally(() => { signingIn = false })
    } else {
      signingIn = false
      connectChannel()
    }

    return () => {
      cancelled = true
      authUnsubscribe?.unsubscribe()
      channelCleanup?.()
    }
  }
}
