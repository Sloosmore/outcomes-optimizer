import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { randomUUID } from 'crypto'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_ANON_KEY) {
  console.error('Missing required env var: SUPABASE_ANON_KEY')
  process.exit(1)
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY')
  process.exit(1)
}

// Inline Zod schema matching agent_events / AgentEventSchema structure
const AgentEventSchema = z.object({
  id: z.string().uuid(),
  process_id: z.string().uuid(),
  process_name: z.string(),
  resource_id: z.string().uuid(),
  source: z.string(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  ts: z.string(),
})

// Generate a unique sentinel value to identify the test row
const sentinel = `test-realtime-gate-${randomUUID()}`

// Anon client for subscribing to realtime changes
const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// Service role client for inserting the test row
const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

let received = false

// Sign in anonymously so the session has the `authenticated` role required by RLS,
// then set up the realtime channel subscription.
;(async () => {
  const { error: signInError } = await anonClient.auth.signInAnonymously()
  if (signInError) {
    console.error('Anonymous sign-in error:', signInError.message)
    process.exit(1)
  }

  const channel = anonClient
    .channel('realtime:agent_events:test')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'agent_events' },
      (payload) => {
        if (payload.new && payload.new.source === sentinel) {
          received = true

          const result = AgentEventSchema.safeParse(payload.new)
          if (!result.success) {
            console.error('Zod parse failed:', result.error.message)
            channel.unsubscribe()
            anonClient.removeAllChannels()
            process.exit(1)
          }

          console.log(`Realtime credential gate passed — sentinel received and validated: ${sentinel}`)
          channel.unsubscribe()
          anonClient.removeAllChannels()
          process.exit(0)
        }
      },
    )
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        // Insert the test row using service_role key
        const row = {
          id: randomUUID(),
          process_id: randomUUID(),
          process_name: 'test-realtime-creds',
          resource_id: randomUUID(),
          source: sentinel,
          payload: null,
          ts: new Date().toISOString(),
        }

        const { error } = await serviceClient.from('agent_events').insert(row)
        if (error) {
          console.error('Insert error:', error.message)
          process.exit(1)
        }
      }
    })

  // Timeout: if no event received within 5 seconds, exit 1
  setTimeout(() => {
    if (!received) {
      console.log('no events received')
      anonClient.removeAllChannels()
      process.exit(1)
    }
  }, 5000)
})()
