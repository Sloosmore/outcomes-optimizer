import type { SupabaseClient } from '@supabase/supabase-js'
import { AgentEventSchema } from '@skill-networks/agent-events'
import type { AgentEvent, EventStreamAdapter } from '@skill-networks/agent-events'

export class PollingAdapter implements EventStreamAdapter {
  private client: SupabaseClient
  private intervalMs = 500

  constructor(client: SupabaseClient) {
    this.client = client
  }

  subscribe(onEvent: (e: AgentEvent) => void): () => void {
    // Track cursor by (ts, id) pair to avoid missing events that share the same timestamp.
    // On each incremental poll: fetch events where ts > lastTs OR (ts == lastTs AND id > lastId).
    let lastTs: string | null = null
    let lastId: string | null = null

    const poll = async () => {
      // Bootstrap: fetch 50 most recent DESC. Incremental: fetch oldest-unseen ASC.
      const ascending = lastTs !== null
      let query = this.client
        .from('agent_events')
        .select('*')
        .order('ts', { ascending })
        .order('id', { ascending })
        .limit(50)

      if (lastTs && lastId) {
        // Compound filter: events strictly newer than lastTs, OR same-ts events with a later id
        query = query.or(`ts.gt.${lastTs},and(ts.eq.${lastTs},id.gt.${lastId})`)
      }

      const { data, error } = await query
      if (error) {
        console.warn('[polling] query failed:', error.message)
        return
      }

      if (!data || data.length === 0) return

      const valid: AgentEvent[] = []
      for (const row of data) {
        const result = AgentEventSchema.safeParse(row)
        if (result.success) {
          valid.push(result.data)
        }
      }

      // Process oldest first
      valid.sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id))

      for (const event of valid) {
        onEvent(event)
      }

      if (valid.length > 0) {
        const last = valid[valid.length - 1]
        lastTs = last.ts
        lastId = last.id
      }
    }

    const safePoll = () => poll().catch(e => console.warn('[polling] unexpected error:', e))
    const id = setInterval(() => void safePoll(), this.intervalMs)

    // Initial poll
    void safePoll()

    return () => clearInterval(id)
  }
}
