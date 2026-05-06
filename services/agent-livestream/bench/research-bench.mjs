#!/usr/bin/env node
/**
 * research-bench.mjs — Full round-trip benchmark with SSH + mermaid
 *
 * Runs a real agent loop: prompt → tool call → SSH to openclaw → mermaid → artifact.
 * Uses messages.create() directly (not query()) so any model works via LiteLLM.
 *
 * Usage:
 *   node --env-file .env bench/research-bench.mjs
 */

import Anthropic from '@anthropic-ai/sdk'
import { SshManager } from '../server/adapters/research/ssh-manager.ts'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO_PATH = process.env.OPENCLAW_REPO_PATH ?? '/root/repos/outcomes-optimizer'
const MAX_TURNS = 10
const MAX_TOKENS = 1500

const SYSTEM = `You are a research assistant with access to a bash tool that runs commands on a remote server.

RULES:
1. Use bash to explore the codebase at ${REPO_PATH}
2. Create a mermaid diagram based on what you find
3. Save the diagram using: cat <<'MERMAID' > /tmp/diagram.mmd
   <your mermaid code>
   MERMAID
4. After saving, respond with EXACTLY this on the last line:
   DIAGRAM_SAVED:/tmp/diagram.mmd
5. Be concise — minimal exploration, then create the diagram.`

const TOOL = {
  name: 'bash',
  description: 'Run a bash command on the remote server',
  input_schema: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
}

const PROMPTS = [
  {
    name: 'Architecture',
    text: `Run 'ls ${REPO_PATH}' to see the top-level structure, then create a mermaid graph TD diagram showing the project architecture (services, packages, utils, skills and their contents). Save it to /tmp/diagram.mmd.`,
  },
  {
    name: 'Data Flow',
    text: `Run 'ls ${REPO_PATH}/services/agent-livestream/server/' to see the server files, then create a mermaid sequenceDiagram showing how a voice message flows from browser → LiveKit → BFF → research tool → SSH → openclaw. Save it to /tmp/diagram.mmd.`,
  },
  {
    name: 'Proxy Flow',
    text: `Run 'ls ${REPO_PATH}/services/credential-proxy/src/' to see the proxy files, then create a mermaid flowchart TD showing how the credential proxy intercepts fetch → resolves credentials → injects headers → forwards upstream. Save it to /tmp/diagram.mmd.`,
  },
]

const MODELS = [
  {
    id: 'haiku',
    label: 'Claude Haiku',
    model: 'claude-haiku-4-5-20251001',
    baseUrl: process.env.ANTHROPIC_BASE_URL || 'http://localhost:8317',
    apiKey: process.env.ANTHROPIC_API_KEY || 'local-dev-key',
  },
  {
    id: 'gpt54mini',
    label: 'gpt-5.4-mini',
    model: 'bench-gpt54mini',
    baseUrl: 'http://localhost:8090',
    apiKey: 'litellm',
  },
  {
    id: 'gemini31',
    label: 'Gemini 3.1 Flash Lite',
    model: 'bench-gemini31',
    baseUrl: 'http://localhost:8090',
    apiKey: 'litellm',
  },
  {
    id: 'gptoss120b',
    label: 'gpt-oss-120b',
    model: 'bench-gptoss120b',
    baseUrl: 'http://localhost:8090',
    apiKey: 'litellm',
  },
  {
    id: 'glm47',
    label: 'GLM-4.7',
    model: 'bench-glm47',
    baseUrl: 'http://localhost:8090',
    apiKey: 'litellm',
  },
]

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

async function runAgentLoop(model, prompt, ssh) {
  const client = new Anthropic({ baseURL: model.baseUrl, apiKey: model.apiKey })
  const messages = [{ role: 'user', content: prompt.text }]
  const start = Date.now()
  let totalTokens = 0
  let turns = 0
  let diagramPath = null

  for (let i = 0; i < MAX_TURNS; i++) {
    turns++
    const resp = await client.messages.create({
      model: model.model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      tools: [TOOL],
      messages,
    })
    totalTokens += resp.usage.output_tokens

    // Check for tool use
    const toolUse = resp.content.find((c) => c.type === 'tool_use')
    const textBlock = resp.content.find((c) => c.type === 'text')

    if (textBlock?.text?.includes('DIAGRAM_SAVED:')) {
      const match = textBlock.text.match(/DIAGRAM_SAVED:(\S+)/)
      if (match) diagramPath = match[1]
    }

    if (resp.stop_reason === 'end_turn' || !toolUse) {
      // Model finished — check if diagram was saved
      if (!diagramPath && textBlock?.text?.includes('DIAGRAM_SAVED:')) {
        const match = textBlock.text.match(/DIAGRAM_SAVED:(\S+)/)
        if (match) diagramPath = match[1]
      }
      break
    }

    // Execute the tool call via SSH
    const command = toolUse.input?.command
    let toolResult = ''
    try {
      const safeRepo = REPO_PATH.replace(/'/g, "'\\''")
      toolResult = await ssh.execOnOpenClaw(`cd '${safeRepo}' && ${command}`, 30_000)
      if (toolResult.length > 3000) toolResult = toolResult.substring(0, 3000) + '\n... (truncated)'
    } catch (err) {
      toolResult = `Error: ${err.message}`
    }

    // Check if the command saved a diagram
    if (command?.includes('/tmp/diagram.mmd')) {
      diagramPath = '/tmp/diagram.mmd'
    }

    // Add assistant + tool result to conversation
    messages.push({ role: 'assistant', content: resp.content })
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: toolResult }],
    })
  }

  const elapsed = Date.now() - start

  // If diagram was saved, read it back
  let mermaidCode = null
  if (diagramPath) {
    try {
      mermaidCode = await ssh.execOnOpenClaw(`cat ${diagramPath} 2>/dev/null`, 5_000)
      if (mermaidCode.trim().length < 10) mermaidCode = null
    } catch {
      mermaidCode = null
    }
  }

  return { elapsed, turns, totalTokens, diagramPath, mermaidCode }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('╔══════════════════════════════════════════════════════════════════╗')
console.log('║  RESEARCH TOOL ROUND-TRIP BENCHMARK                            ║')
console.log('║  Real path: messages.create → SSH → bash on openclaw → diagram ║')
console.log('╚══════════════════════════════════════════════════════════════════╝')

const allResults = []

for (const prompt of PROMPTS) {
  console.log(`\n━━ ${prompt.name} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)

  for (const model of MODELS) {
    process.stdout.write(`  ${model.label.padEnd(28)}`)
    const ssh = new SshManager()

    try {
      const r = await runAgentLoop(model, prompt, ssh)
      const diagramIcon = r.mermaidCode ? '✓' : '✗'
      console.log(`${r.elapsed}ms | ${r.turns} turns | ${r.totalTokens} tok | diagram:${diagramIcon}`)
      if (r.mermaidCode) {
        const preview = r.mermaidCode.trim().split('\n').slice(0, 2).join(' | ')
        console.log(`${''.padEnd(30)}${preview}`)
      }
      allResults.push({ ...r, model: model.id, label: model.label, prompt: prompt.name })
    } catch (err) {
      console.log(`ERROR: ${err.message?.substring(0, 120)}`)
      allResults.push({ model: model.id, label: model.label, prompt: prompt.name, error: err.message, elapsed: 0 })
    } finally {
      ssh.close()
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n\n══ SUMMARY ════════════════════════════════════════════════════════')
console.log('Model'.padEnd(28) + 'Avg Time'.padEnd(12) + 'Avg Turns'.padEnd(12) + 'Diagrams')

for (const m of MODELS) {
  const runs = allResults.filter((r) => r.model === m.id && !r.error)
  if (runs.length === 0) {
    console.log(`${m.label.padEnd(28)}ALL FAILED`)
    continue
  }
  const avgTime = Math.round(runs.reduce((s, r) => s + r.elapsed, 0) / runs.length)
  const avgTurns = (runs.reduce((s, r) => s + (r.turns || 0), 0) / runs.length).toFixed(1)
  const diagrams = runs.filter((r) => r.mermaidCode).length
  console.log(`${m.label.padEnd(28)}${(avgTime + 'ms').padEnd(12)}${avgTurns.padEnd(12)}${diagrams}/${runs.length}`)
}

// Output diagrams for quality review
const withDiagrams = allResults.filter((r) => r.mermaidCode)
if (withDiagrams.length > 0) {
  console.log('\n\n══ GENERATED DIAGRAMS ═════════════════════════════════════════════')
  for (const r of withDiagrams) {
    console.log(`\n--- ${r.label} — ${r.prompt} (${r.elapsed}ms) ---`)
    console.log(r.mermaidCode?.trim())
  }
}
