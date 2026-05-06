const supabaseUrl = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_KEY
const accessToken = process.env.SUPABASE_ACCESS_TOKEN
const projectRef = process.env.SUPABASE_PROJECT_REF

if (!supabaseUrl || !serviceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY')
  process.exit(1)
}
if (!accessToken || !projectRef) {
  console.error('Missing SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_REF')
  process.exit(1)
}

// Step 1: Fetch anon key from Supabase Management API
const keysRes = await fetch(
  `https://api.supabase.com/v1/projects/${projectRef}/api-keys`,
  { headers: { Authorization: `Bearer ${accessToken}` } }
)
if (!keysRes.ok) {
  console.error(`Failed to fetch API keys: ${keysRes.status} ${await keysRes.text()}`)
  process.exit(1)
}
const keys = await keysRes.json()
const anonKey = keys.find(k => k.name === 'anon')?.api_key ?? keys[0]?.api_key
if (!anonKey) {
  console.error('Could not find anon key in API keys response')
  process.exit(1)
}
console.log('Fetched anon key from management API')

const endpoint = `${supabaseUrl}/rest/v1/agent_events?select=id&limit=100`

// Step 2: Query with anon key — expect 0 rows
const anonRes = await fetch(endpoint, {
  headers: {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`
  }
})
const anonRows = anonRes.ok ? await anonRes.json() : []
console.log(`Anon query: ${anonRows.length} rows (status ${anonRes.status})`)

if (anonRows.length !== 0) {
  console.error('FAIL: anon key returned rows — RLS is not blocking anonymous access')
  process.exit(1)
}
console.log('PASS: anon key returned 0 rows')

// Step 3: Query with service_role key — expect ≥15 rows with source=test-script
const serviceEndpoint = `${supabaseUrl}/rest/v1/agent_events?select=id&source=eq.test-script&limit=100`
const serviceRes = await fetch(serviceEndpoint, {
  headers: {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`
  }
})
if (!serviceRes.ok) {
  console.error(`Service role query failed: ${serviceRes.status} ${await serviceRes.text()}`)
  process.exit(1)
}
const serviceRows = await serviceRes.json()
console.log(`Service role query: ${serviceRows.length} rows`)

if (serviceRows.length < 15) {
  console.error(`FAIL: service_role key returned ${serviceRows.length} rows, expected ≥15`)
  process.exit(1)
}
console.log('PASS: service_role key returned ≥15 rows')

console.log('All RLS lockdown checks passed')
