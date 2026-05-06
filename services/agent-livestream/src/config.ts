import type { EventHistoryAdapter, GraphDataAdapter } from '@skill-networks/agent-events'
import type { RealtimeAdapter } from './adapters/realtime-adapter'
import type { SessionAdapter } from '@duoidal/auth/adapters'
import type { AgentEvent } from '@skill-networks/agent-events'
import { AgentEventSchema } from '@skill-networks/agent-events'
import { TableRealtimeAdapter } from './adapters/realtime-adapter'
import { MagicLinkSessionAdapter, DebugSessionAdapter } from '@duoidal/auth/adapters'
import { HttpGraphDataAdapter } from './adapters/http-graph-data-adapter'
import { apiFetch } from './lib/api-fetch'
import { supabaseClient, supabaseUrl, supabaseAnonKey } from './lib/supabase-client'

// Debug credentials must never be set in production builds — they are embedded in the client bundle
if (import.meta.env.PROD && (import.meta.env.VITE_DEBUG_EMAIL || import.meta.env.VITE_DEBUG_PASSWORD)) {
  throw new Error('VITE_DEBUG_EMAIL/PASSWORD must not be set in production builds — credentials would be served to every browser client')
}

export const authAdapter: SessionAdapter =
  (import.meta.env.VITE_DEBUG_EMAIL && import.meta.env.VITE_DEBUG_PASSWORD)
    ? new DebugSessionAdapter(supabaseUrl, supabaseAnonKey, import.meta.env.VITE_DEBUG_EMAIL, import.meta.env.VITE_DEBUG_PASSWORD, async () => {
        await fetch('/dev/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: import.meta.env.VITE_DEBUG_EMAIL,
            newPassword: import.meta.env.VITE_DEBUG_PASSWORD,
          }),
        })
      })
    : new MagicLinkSessionAdapter(supabaseClient)

export { supabaseClient }

const agentEventsAdapter = new TableRealtimeAdapter(
  'agent_events',
  AgentEventSchema,
  supabaseClient,
  authAdapter,
)

export const streamAdapter: RealtimeAdapter<AgentEvent> = agentEventsAdapter
export const graphAdapter: GraphDataAdapter = new HttpGraphDataAdapter(apiFetch)

// historyAdapter is no longer needed (history comes via Realtime stream catchup)
// Keep export for backwards compat but use a no-op
export const historyAdapter: EventHistoryAdapter = {
  getHistory: async () => []
}
