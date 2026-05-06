import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

const PROCESSES = [
  { id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', name: 'diagnostic-agent' },
  { id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901', name: 'retrieval-agent' },
  { id: 'c3d4e5f6-a7b8-9012-cdef-123456789012', name: 'creative-agent' },
]

// Middle-grid resources (positions ~45-65 in the array) to ensure visibility in viewport
const RESOURCES = [
  'ffdfc2c7-b57d-4900-89ba-52bbd09e90b9', // meta-app (pos 50)
  'edb5d809-755e-4d5a-8157-d7fd1769e2a1', // goal/e2e-test-divide (pos 51)
  '3ded9ef1-c908-4353-ab79-0ac366ed9c48', // goal/credential-proxy (pos 52)
  'a4ec49f4-4e85-4936-8396-5ea5823bf0db', // goal/auto-deploy (pos 53)
  '7b78af7e-88b4-4742-8a9b-1a9488831c7d', // goal/goal-as-resource (pos 55)
  'cc5d1d9b-8cb4-4849-849c-968d349c0b62', // goal/mechanics-test (pos 57)
]

// Round definitions: [processA_resource, processB_resource, processC_resource]
const ROUNDS = [
  [RESOURCES[0], RESOURCES[1], RESOURCES[2]],
  [RESOURCES[3], RESOURCES[1], RESOURCES[4]],
  [RESOURCES[3], RESOURCES[5], RESOURCES[2]],
]

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

for (let round = 0; round < ROUNDS.length; round++) {
  const assignments = ROUNDS[round]
  for (let p = 0; p < PROCESSES.length; p++) {
    const row = {
      id: randomUUID(),
      process_id: PROCESSES[p].id,
      process_name: PROCESSES[p].name,
      resource_id: assignments[p],
      source: 'test-script',
      payload: { round: round + 1 },
      ts: new Date().toISOString(),
    }
    const { error } = await supabase.from('agent_events').insert(row)
    if (error) console.error(`Insert error round ${round + 1}:`, error.message)
  }
  console.log(`Round ${round + 1} emitted`)
  if (round < ROUNDS.length - 1) {
    await sleep(2000)
  }
}

// Wait for Realtime propagation
await sleep(500)
console.log('Done')
