#!/usr/bin/env node
/**
 * diagram-bench.mjs — Round-trip benchmark for diagram generation
 *
 * Measures wall clock from request → tool call → tool result → diagram output.
 * Each model gets the same 3 prompts and a simulated codebase tool result.
 *
 * Usage:
 *   node bench/diagram-bench.mjs
 *
 * Required env vars:
 *   GOOGLE_API_KEY        — Gemini
 *   OPENAI_API_KEY        — gpt-5.4-mini
 *   CEREBRAS_API_KEY      — gpt-oss-120b, zai-glm-4.7 (optional)
 *   ANTHROPIC_BASE_URL    — for Haiku baseline (e.g. http://localhost:8317)
 *   ANTHROPIC_API_KEY     — for Haiku baseline
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TOOL_DEF_OPENAI = {
  type: 'function',
  function: {
    name: 'bash',
    description: 'Run a bash command on the remote server to explore the codebase',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
}

const SYSTEM = `You are a research assistant. You MUST:
1. First call the bash tool to explore the codebase.
2. Then respond with a mermaid diagram inside a \`\`\`mermaid code fence.
Your final response MUST contain a \`\`\`mermaid code block. No exceptions. Do not explain — just produce the diagram.`

const DIAGRAMS = [
  {
    name: 'Architecture',
    prompt: 'Use bash to explore the directory structure, then output a mermaid graph TD diagram showing the high-level architecture. Your response MUST contain a ```mermaid code block.',
    toolResult: `services/
  agent-interceptor/
  agent-livestream/
  credential-proxy/
packages/
  agent-browser/
  agent-media/
  agent-email/
utils/
  cli/
  loop/
  run/
  database/
skills/
  dispatch/
  create-skill/
  oversight/`,
  },
  {
    name: 'Data Flow',
    prompt: 'Use bash to look at the server routes, then output a mermaid sequenceDiagram showing how a voice chat message flows from browser to backend. Your response MUST contain a ```mermaid code block.',
    toolResult: `server/routes/token.ts — LiveKit token generation
server/voice-agent.ts — LiveKit agent worker, uses OpenAI STT/TTS
server/local-llm.ts — local LLM adapter for tool calls
server/tools.ts — research tool registry
server/adapters/research/claude-code-sdk-adapter.ts — Claude Code SDK research
server/adapters/research/ssh-manager.ts — SSH to OpenClaw`,
  },
  {
    name: 'Credential Proxy',
    prompt: 'Use bash to read the proxy source, then output a mermaid flowchart showing how the credential proxy intercepts and injects credentials. Your response MUST contain a ```mermaid code block.',
    toolResult: `interceptor.ts — patches globalThis.fetch, routes through proxy
router.ts — resolves credentials from DB + Doppler, SSRF guard
handler.ts — reads X-Target-URL, injects headers, forwards upstream
db.ts — resolves resource by name or hostname
store/doppler.ts — fetches secrets from Doppler with TTL cache
AI_PROVIDER_BYPASS_HOSTS: api.anthropic.com, api.openai.com, generativelanguage.googleapis.com`,
  },
]

// ---------------------------------------------------------------------------
// Model adapters
// ---------------------------------------------------------------------------

async function callOpenAICompat(baseUrl, apiKey, model, messages, label) {
  const start = Date.now()

  // Turn 1: get tool call
  const r1 = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      tools: [TOOL_DEF_OPENAI],
      tool_choice: 'auto',
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
    }),
  })
  const d1 = await r1.json()
  if (!d1.choices) return { label, error: d1.message || d1.error?.message || JSON.stringify(d1).slice(0, 200) }

  const turn1Ms = Date.now() - start
  const choice1 = d1.choices[0]

  // If model didn't call a tool, it went straight to diagram
  if (choice1.finish_reason !== 'tool_calls' || !choice1.message.tool_calls?.length) {
    return {
      label,
      turn1Ms,
      turn2Ms: 0,
      totalMs: turn1Ms,
      tokens: d1.usage?.completion_tokens ?? 0,
      hasDiagram: (choice1.message.content || '').includes('```'),
      serverMs: Math.round((d1.time_info?.total_time ?? 0) * 1000),
    }
  }

  const tc = choice1.message.tool_calls[0]
  const toolCallId = tc.id

  // Turn 2: provide tool result, get diagram
  const turn2Start = Date.now()
  const r2 = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      messages: [
        { role: 'system', content: SYSTEM },
        ...messages,
        choice1.message,
        { role: 'tool', tool_call_id: toolCallId, content: messages[0]._toolResult },
      ],
    }),
  })
  const d2 = await r2.json()
  if (!d2.choices) return { label, error: d2.message || d2.error?.message || JSON.stringify(d2).slice(0, 200) }

  const turn2Ms = Date.now() - turn2Start
  const totalMs = Date.now() - start
  const content = d2.choices[0].message.content || ''

  return {
    label,
    turn1Ms,
    turn2Ms,
    totalMs,
    tokens: (d1.usage?.completion_tokens ?? 0) + (d2.usage?.completion_tokens ?? 0),
    hasDiagram: content.includes('```'),
    serverMs: Math.round(((d1.time_info?.total_time ?? 0) + (d2.time_info?.total_time ?? 0)) * 1000),
  }
}

async function callAnthropic(baseUrl, apiKey, model, prompt, toolResult, label) {
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const client = new Anthropic({ baseURL: baseUrl, apiKey })

  const start = Date.now()

  // Turn 1: get tool call
  const msg1 = await client.messages.create({
    model,
    max_tokens: 800,
    system: SYSTEM,
    tools: [{
      name: 'bash',
      description: 'Run a bash command on the remote server to explore the codebase',
      input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    }],
    messages: [{ role: 'user', content: prompt }],
  })
  const turn1Ms = Date.now() - start

  // If no tool use, model went straight to answer
  const toolUse = msg1.content.find(c => c.type === 'tool_use')
  if (!toolUse) {
    const text = msg1.content.find(c => c.type === 'text')?.text || ''
    return { label, turn1Ms, turn2Ms: 0, totalMs: turn1Ms, tokens: msg1.usage.output_tokens, hasDiagram: text.includes('```'), serverMs: 0 }
  }

  // Turn 2: provide tool result, get diagram
  const turn2Start = Date.now()
  const msg2 = await client.messages.create({
    model,
    max_tokens: 800,
    system: SYSTEM,
    messages: [
      { role: 'user', content: prompt },
      { role: 'assistant', content: msg1.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: toolResult }] },
    ],
  })
  const turn2Ms = Date.now() - turn2Start
  const totalMs = Date.now() - start
  const finalText = msg2.content.find(c => c.type === 'text')?.text || ''

  return {
    label,
    turn1Ms,
    turn2Ms,
    totalMs,
    tokens: msg1.usage.output_tokens + msg2.usage.output_tokens,
    hasDiagram: finalText.includes('```'),
    serverMs: 0,
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const GOOGLE_KEY = process.env.GOOGLE_API_KEY
const OPENAI_KEY = process.env.OPENAI_API_KEY
const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL || 'http://localhost:8317'
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || 'local-dev-key'
const LITELLM_BASE = 'http://localhost:8080'

const models = [
  { id: 'haiku', label: 'Claude Haiku', type: 'anthropic', baseUrl: ANTHROPIC_BASE, apiKey: ANTHROPIC_KEY, model: 'claude-haiku-4-5-20251001' },
  { id: 'gpt54mini', label: 'gpt-5.4-mini', type: 'anthropic', baseUrl: LITELLM_BASE, apiKey: 'dummy', model: 'claude-haiku-4-5-20251001' },
  ...(GOOGLE_KEY ? [{ id: 'gemini', label: 'Gemini 3.1 Flash Lite', type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: GOOGLE_KEY, model: 'gemini-3.1-flash-lite-preview' }] : []),
  ...(CEREBRAS_KEY ? [
    { id: 'gptoss', label: 'gpt-oss-120b (Cerebras)', type: 'openai', baseUrl: 'https://api.cerebras.ai/v1', apiKey: CEREBRAS_KEY, model: 'gpt-oss-120b' },
    { id: 'glm47', label: 'GLM-4.7 (Cerebras)', type: 'openai', baseUrl: 'https://api.cerebras.ai/v1', apiKey: CEREBRAS_KEY, model: 'zai-glm-4.7' },
  ] : []),
]

console.log('╔══════════════════════════════════════════════════════════════╗')
console.log('║  DIAGRAM ROUND-TRIP BENCHMARK — 3 diagrams × N models      ║')
console.log('╚══════════════════════════════════════════════════════════════╝')
console.log()

const results = []

for (const diagram of DIAGRAMS) {
  console.log(`\n── ${diagram.name} ──────────────────────────────────────────`)

  for (const m of models) {
    process.stdout.write(`  ${m.label.padEnd(28)}`)
    try {
      let result
      if (m.type === 'anthropic') {
        result = await callAnthropic(m.baseUrl, m.apiKey, m.model, diagram.prompt, diagram.toolResult, m.label)
      } else {
        const msgs = [{ role: 'user', content: diagram.prompt, _toolResult: diagram.toolResult }]
        result = await callOpenAICompat(m.baseUrl, m.apiKey, m.model, msgs, m.label)
      }

      if (result.error) {
        console.log(`ERROR: ${result.error.slice(0, 80)}`)
        results.push({ model: m.id, diagram: diagram.name, error: result.error })
      } else {
        const diagramIcon = result.hasDiagram ? '✓' : '✗'
        const serverNote = result.serverMs > 0 ? ` (server: ${result.serverMs}ms)` : ''
        console.log(`${result.totalMs}ms total (T1:${result.turn1Ms} T2:${result.turn2Ms}) | ${result.tokens} tok | diagram:${diagramIcon}${serverNote}`)
        results.push({ model: m.id, diagram: diagram.name, ...result })
      }
    } catch (err) {
      console.log(`CRASH: ${err.message?.slice(0, 80)}`)
      results.push({ model: m.id, diagram: diagram.name, error: err.message })
    }
  }
}

// Summary table
console.log('\n\n══ SUMMARY ═══════════════════════════════════════════════════')
console.log('Model'.padEnd(28) + 'Avg Total'.padEnd(12) + 'Avg T1'.padEnd(10) + 'Avg T2'.padEnd(10) + 'Diagrams')

for (const m of models) {
  const runs = results.filter(r => r.model === m.id && !r.error)
  if (runs.length === 0) {
    console.log(`${m.label.padEnd(28)}NO DATA`)
    continue
  }
  const avgTotal = Math.round(runs.reduce((s, r) => s + r.totalMs, 0) / runs.length)
  const avgT1 = Math.round(runs.reduce((s, r) => s + r.turn1Ms, 0) / runs.length)
  const avgT2 = Math.round(runs.reduce((s, r) => s + r.turn2Ms, 0) / runs.length)
  const diagrams = runs.filter(r => r.hasDiagram).length
  console.log(`${m.label.padEnd(28)}${(avgTotal + 'ms').padEnd(12)}${(avgT1 + 'ms').padEnd(10)}${(avgT2 + 'ms').padEnd(10)}${diagrams}/${runs.length}`)
}
