const [,, processId, processName, resourceId] = process.argv
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY')
  process.exit(1)
}

for (let i = 0; i < 5; i++) {
  const row = {
    id: crypto.randomUUID(),
    process_id: processId,
    process_name: processName,
    resource_id: resourceId,
    source: 'test-script',
    payload: { seq: i },
    ts: new Date().toISOString()
  }
  const res = await fetch(`${supabaseUrl}/rest/v1/agent_events`, {
    method: 'POST',
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(row)
  })
  if (!res.ok) {
    const text = await res.text()
    console.error(`Insert failed: ${res.status} ${text}`)
    process.exit(1)
  }
  console.log(`Emitted event ${i+1}/5 for ${processName}`)
  await new Promise(r => setTimeout(r, 200))
}
console.log(`Done: ${processName} emitted 5 events to ${supabaseUrl}`)
