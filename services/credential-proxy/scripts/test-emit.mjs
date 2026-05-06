#!/usr/bin/env node
// Test that SupabaseEventEmitterAdapter can write to the branch agent_events table

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY')
  process.exit(1)
}

// Use dynamic import — use the CJS dist which works cleanly in Node
const { SupabaseEventEmitterAdapter } = await import('../../agent-events/dist/index.js')

const emitter = new SupabaseEventEmitterAdapter(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// Get a real resource_id from the branch DB (any one will do)
const res = await fetch(`${SUPABASE_URL}/rest/v1/resources?limit=1&select=id`, {
  headers: {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
  }
})
const resources = await res.json()
const resourceId = resources[0]?.id
if (!resourceId) { console.error('No resources found'); process.exit(1) }

const processId = globalThis.crypto.randomUUID()
emitter.emit({
  process_id: processId,
  process_name: 'credential-proxy-test',
  resource_id: resourceId,
  source: 'credential-proxy',
  payload: { test: true }
})

// Wait for the insert
await new Promise(r => setTimeout(r, 2000))

// Verify the row appeared
const checkRes = await fetch(
  `${SUPABASE_URL}/rest/v1/agent_events?process_id=eq.${processId}&select=id,process_name,resource_id`,
  {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
    }
  }
)
const rows = await checkRes.json()
if (rows.length === 0) {
  console.error('FAIL: No row found in agent_events')
  process.exit(1)
}
console.log('PASS: Row confirmed in agent_events:', JSON.stringify(rows[0]))
