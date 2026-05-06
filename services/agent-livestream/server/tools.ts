import type { SupabaseClient } from '@supabase/supabase-js'

// All three helpers are lazy-imported to keep this module importable in
// contexts where @skill-networks/database/services and the SSH deps are not
// available (e.g. the voice-agent test environment, Vercel serverless).
async function getDefaultDb(): Promise<SupabaseClient> {
  const mod = await import('./lib/supabase.js')
  return mod.supabase
}

async function getResolveSandboxCtx() {
  const mod = await import('./lib/resolve-sandbox-ctx.js')
  return mod.resolveSandboxCtx
}

async function getRunSandboxAgent() {
  const mod = await import('./adapters/research/sandbox-agent-runner.js')
  return mod.runSandboxAgent
}

// ---------------------------------------------------------------------------
// Tool registry — single source of truth for tool metadata + execution.
//
// Voice (voice-agent.ts) and chat (routes/tools.ts, routes/chat-stream.ts)
// both consume this registry. Voice has its own per-tool execute closures
// (see server/tools/claude-code-tool.ts) that need the LiveKit AgentSession +
// JobContext; the chat path uses buildTools(ctx) to get an execute that's
// already bound to the acting user.
//
// Both paths run claude_code the same way: SSH into the user's sandbox and
// execute research.mjs (the in-sandbox Claude Code runner) there. The sandbox
// owns artifact generation, port allocation, and HTTP serving. tools.ts is a
// thin dispatch.
//
// Three tools: "claude_code", "share_screen", "dispatch".
// ---------------------------------------------------------------------------

let claudeCodeLock: Promise<void> = Promise.resolve()
async function withClaudeCodeLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = claudeCodeLock
  let release!: () => void
  claudeCodeLock = new Promise<void>((r) => { release = r })
  await prev
  try {
    return await fn()
  } finally {
    release()
  }
}

export interface ToolExecuteCtx {
  /** The acting user's auth_user_id (Supabase JWT sub). */
  authUserId: string
  /** Supabase client for credential lookups. Defaults to the service-role admin client. */
  db?: SupabaseClient
}

export interface ToolMeta {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, Record<string, unknown>>
    required: string[]
  }
}

export interface ToolDefinition extends ToolMeta {
  execute: (input: Record<string, unknown>) => Promise<unknown>
}

export const CLAUDE_CODE_TOOL_DESCRIPTION =
  "Run Claude Code inside the user's sandbox to investigate the codebase, perform a computation, or generate a renderable artifact (diagram, report, code analysis). Returns a text summary. If the summary contains a URL, you MUST call share_screen with that URL passed VERBATIM (copy-paste, byte-for-byte). claude_code itself does not display anything; rendering is a separate decision."

export const SHARE_SCREEN_TOOL_DESCRIPTION =
  "Display an https URL in the user's browser artifact panel, OR flip the panel's view mode without changing what is shown. Pass `url` to share something new (byte-for-byte exactly as it appears in your source — claude_code result, user message, or known public site; do NOT paraphrase, shorten, abbreviate, or fill placeholders). Pass `mode` to control the view: `'focus'` = single full-bleed, `'spotlight'` = multi-tile Stage Manager. To switch view modes for the currently shared artifact, omit `url` and pass only `mode`. To share a new URL without changing the view, omit `mode`. Both can be passed together."

export const DISPATCH_TOOL_DESCRIPTION =
  "Dispatch a new task on behalf of the user. Provide spec_url — a URL to a markdown spec describing what to do (a grip-served README, a GitHub raw markdown URL, a Gist, or any publicly fetchable .md). The user's dashboard will zoom in on the dispatched task as it runs. Use this when the user asks to start a task, kick off work, run a goal, or dispatch a job. Optional `mode` toggles the panel's view: `'focus'` switches to single full-bleed view, `'spotlight'` switches to multi-tile Stage Manager view."

const TOOL_METAS: ToolMeta[] = [
  {
    name: 'claude_code',
    description: CLAUDE_CODE_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The instruction for Claude Code — what to investigate, compute, or visualize.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'share_screen',
    description: SHARE_SCREEN_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: "Optional. The https URL to display. Omit to keep the currently shared artifact and only flip the view via `mode`.",
        },
        mode: {
          type: 'string',
          enum: ['focus', 'spotlight'],
          description: "Optional view toggle: 'focus' switches to single full-bleed view, 'spotlight' switches to multi-tile Stage Manager view. Omit to preserve the current view.",
        },
      },
      required: [],
    },
  },
  {
    name: 'dispatch',
    description: DISPATCH_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        spec_url: {
          type: 'string',
          description: 'URL to a markdown spec describing the task. Pass the URL byte-for-byte as the user provides it.',
        },
        mode: {
          type: 'string',
          enum: ['focus', 'spotlight'],
          description: "Optional view toggle: 'focus' switches to single full-bleed view, 'spotlight' switches to multi-tile Stage Manager view. Omit to preserve the current view.",
        },
      },
      required: ['spec_url'],
    },
  },
]

async function executeClaudeCode(input: Record<string, unknown>, ctx: ToolExecuteCtx): Promise<unknown> {
  const prompt = input['prompt']
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('Missing required parameter: prompt (non-empty string)')
  }
  if (prompt.length > 10_000) {
    throw new Error('prompt exceeds maximum length (10000 chars)')
  }
  const db = ctx.db ?? (await getDefaultDb())
  const resolveSandboxCtx = await getResolveSandboxCtx()
  const resolved = await resolveSandboxCtx(db, ctx.authUserId)
  if (resolved.error || !resolved.ctx) {
    throw new Error(`claude_code: cannot resolve user sandbox (${resolved.error ?? 'unknown'})`)
  }
  const sandbox = resolved.ctx
  const runSandboxAgent = await getRunSandboxAgent()
  return withClaudeCodeLock(() =>
    runSandboxAgent(prompt, {
      host: sandbox.host,
      privateKey: sandbox.privateKey,
      sandboxId: sandbox.sandboxId,
      timeoutMs: 300_000,
    }),
  )
}

async function executeShareScreen(input: Record<string, unknown>): Promise<unknown> {
  const url = input['url']
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new Error('Missing required parameter: url (non-empty string)')
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('share_screen: invalid URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('share_screen: only https URLs are accepted')
  }
  return {
    text: `<open_artifact url="${url}" label="Shared link" />`,
    url,
  }
}

/**
 * Build the per-request tool set bound to the acting user. The chat path
 * (routes/tools.ts and chat-stream.ts) calls this once per request to get
 * tools whose execute() closure already knows who's calling.
 *
 * `dispatch` is intentionally omitted here — the voice path (voice-agent.ts)
 * has its own execute closure that emits `artifact_ready` over the LiveKit
 * data channel, which the text chat surface doesn't consume. Add a chat-side
 * implementation later if/when chat surfaces the artifact iframe.
 */
export function buildTools(ctx: ToolExecuteCtx): Record<string, ToolDefinition> {
  const out: Record<string, ToolDefinition> = {}
  for (const meta of TOOL_METAS) {
    if (meta.name === 'claude_code') {
      out[meta.name] = { ...meta, execute: (input) => executeClaudeCode(input, ctx) }
    } else if (meta.name === 'share_screen') {
      out[meta.name] = { ...meta, execute: (input) => executeShareScreen(input) }
    }
  }
  return out
}

export function getAllToolDefs(): ToolMeta[] {
  return TOOL_METAS
}

export function getToolDef(name: string): ToolMeta | undefined {
  return TOOL_METAS.find((t) => t.name === name)
}
